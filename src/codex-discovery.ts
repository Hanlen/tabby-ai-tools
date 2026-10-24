import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Readable } from 'stream'
import { codexEnvironment, ExecutableContext, normalizeExecutable, resolveCodexExecutable } from './codex-executable'

export interface CodexLaunch {
  executable: string
  env: NodeJS.ProcessEnv
}

export interface DiscoveryContext extends ExecutableContext {
  signal?: AbortSignal
  shellTimeoutMs?: number
  /** Override host-level locations for filesystem-backed discovery tests. */
  systemDirectories?: string[]
}

// Import only settings needed by Codex and its runtime. In particular, never
// import shell NODE_OPTIONS, loader hooks or the internal originator override.
const SHELL_KEYS = [
  'CODEX_HOME', 'CODEX_SQLITE_HOME', 'CODEX_INSTALL_DIR', 'NVM_DIR',
  'CODEX_CA_CERTIFICATE', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN',
]

function checkCancelled (signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Codex app-server was closed during CLI discovery')
}

function launchEnvironment (executable: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): CodexLaunch {
  // Keep the launcher path, not its npm symlink target: its adjacent node wins.
  return {
    executable,
    env: platform === 'linux' || platform === 'darwin'
      ? { ...env, PATH: path.dirname(executable) + (env.PATH ? ':' + env.PATH : '') }
      : env,
  }
}

/** NUL-delimited key/value pairs on a private pipe, isolated from shell banners. */
function userShellEnvironment (env: NodeJS.ProcessEnv, cwd: string, platform: NodeJS.Platform, context: DiscoveryContext): Promise<NodeJS.ProcessEnv> {
  return new Promise((resolve, reject) => {
    const shell = env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
    const name = path.basename(shell)
    if (!path.isAbsolute(shell) || !['bash', 'zsh', 'sh', 'dash', 'ksh', 'fish'].includes(name)) {
      reject(new Error(`${shell}: 不支持的用户 Shell；继续检查安装目录`))
      return
    }
    const command = name === 'fish'
      ? ["printf '%s\\0%s\\0' PATH (string join : $PATH) >&3", ...SHELL_KEYS.map(key =>
        `if set -q ${key}; printf '%s\\0%s\\0' '${key}' "$${key}" >&3; end`)].join('\n')
      : ["printf '%s\\0%s\\0' PATH \"${PATH-}\" >&3", ...SHELL_KEYS.map(key =>
        `if [ "\${${key}+x}" = x ]; then printf '%s\\0%s\\0' '${key}' "$${key}" >&3; fi`)].join('\n')
    const child = spawn(shell, ['-ilc', command], {
      cwd, env, detached: true, shell: false,
      stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
    })
    const pipe = child.stdio[3] as Readable
    let settled = false
    let output = Buffer.alloc(0)
    const finish = (error?: Error, value?: NodeJS.ProcessEnv): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      context.signal?.removeEventListener('abort', abort)
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
      pipe.destroy()
      if (error) reject(error)
      else resolve(value!)
    }
    const abort = (): void => finish(new Error('Codex app-server was closed during CLI discovery'))
    const timer = setTimeout(() => finish(new Error(`${shell}: 探测超时（${context.shellTimeoutMs ?? 3000} ms）`)), context.shellTimeoutMs ?? 3000)
    context.signal?.addEventListener('abort', abort, { once: true })
    if (context.signal?.aborted) abort()
    child.on('error', (error: NodeJS.ErrnoException) => finish(new Error(`${shell}: ${error.code || error.message}`)))
    pipe.on('error', error => finish(error))
    pipe.on('data', (data: Buffer) => {
      if (settled) return
      if (output.length + data.length > 65536) {
        finish(new Error(`${shell}: 环境探测输出超过 64 KiB`))
        return
      }
      output = Buffer.concat([output, data])
    })
    child.on('close', (code, signal) => {
      if (settled) return
      if (code !== 0) return finish(new Error(`${shell}: 探测退出（${code ?? signal}）`))
      const fields = output.toString('utf8').split('\0')
      if (fields.pop() !== '' || !fields.length || fields.length % 2) {
        return finish(new Error(`${shell}: 未返回有效环境`))
      }
      const values: NodeJS.ProcessEnv = {}
      for (let i = 0; i < fields.length; i += 2) {
        const key = fields[i]
        if ((key !== 'PATH' && !SHELL_KEYS.includes(key)) || values[key] !== undefined) {
          return finish(new Error(`${shell}: 未返回有效环境`))
        }
        values[key] = fields[i + 1]
      }
      if (values.PATH === undefined) return finish(new Error(`${shell}: 未返回有效环境`))
      finish(undefined, values)
    })
  })
}

function mergeShellEnvironment (inherited: NodeJS.ProcessEnv, shell: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...inherited }
  for (const key of SHELL_KEYS) {
    // An explicitly inherited value, including an empty value, takes priority.
    if (env[key] === undefined && shell[key] !== undefined) env[key] = shell[key]
  }
  env.PATH = [shell.PATH, inherited.PATH].filter(Boolean).join(':')
  return codexEnvironment(env)
}

function nodeExecutable (env: NodeJS.ProcessEnv, context: ExecutableContext): string | undefined {
  try { return resolveCodexExecutable('node', { ...context, env }) } catch { return undefined }
}

async function needsNode (executable: string): Promise<boolean> {
  const file = await fs.promises.open(executable, 'r')
  try {
    const buffer = Buffer.alloc(512)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    return /^#![^\r\n]*\/env\s+(?:-S\s+)?node(?:\s|$)/.test(buffer.toString('utf8', 0, bytesRead).split('\n')[0])
  } finally { await file.close() }
}

async function installDirectories (home: string, env: NodeJS.ProcessEnv, cwd: string, context: DiscoveryContext, reasons: string[]): Promise<string[]> {
  const directories = [path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin')]
  const nvmRoots = [...new Set([env.NVM_DIR, path.join(home, '.nvm')].filter((value): value is string => !!value))]
  for (const nvmRoot of nvmRoots) {
    const root = path.resolve(cwd, nvmRoot)
    directories.push(path.join(root, 'current', 'bin'))
    const versions = path.join(root, 'versions', 'node')
    try {
      const entries = await fs.promises.readdir(versions, { withFileTypes: true })
      entries.filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) && /^v\d+\.\d+\.\d+$/.test(entry.name))
        .sort((a, b) => b.name.localeCompare(a.name, 'en', { numeric: true }))
        .forEach(entry => directories.push(path.join(versions, entry.name, 'bin')))
    } catch (error: any) { reasons.push(`NVM ${versions}: ${error.code || error.message}`) }
    checkCancelled(context.signal)
  }
  directories.push(...(context.systemDirectories || ['/opt/homebrew/bin', '/usr/local/bin']))
  if ((context.platform || process.platform) === 'darwin') {
    directories.push(path.join(home, 'Applications', 'ChatGPT.app', 'Contents', 'Resources'))
    // systemDirectories replaces host-level locations in discovery fixtures.
    if (!context.systemDirectories) directories.push('/Applications/ChatGPT.app/Contents/Resources')
  }
  return [...new Set(directories)]
}

/** Resolve the CLI once; environment recovery must never replace a selected CLI. */
export async function resolveCodexLaunch (configured: string, context: DiscoveryContext = {}): Promise<CodexLaunch> {
  const platform = context.platform || process.platform
  let env = codexEnvironment(context.env || process.env)
  const home = context.home || env.HOME || os.homedir()
  const cwd = context.cwd || process.cwd()
  const resolution = { ...context, platform, home, cwd }
  const value = normalizeExecutable(configured)
  const automatic = !value || value === 'codex'
  checkCancelled(context.signal)
  let executable: string | undefined
  let originalError: Error | undefined
  try { executable = resolveCodexExecutable(configured, { ...resolution, env }) } catch (error: any) {
    if (!automatic || (platform !== 'linux' && platform !== 'darwin')) throw error
    originalError = error
  }
  if (platform !== 'linux' && platform !== 'darwin') return launchEnvironment(executable!, env, platform)

  // Explicit/custom CLIs retain their lookup contract. Only missing Node can
  // require environment recovery for these; invalid paths/names already failed.
  if (executable && !automatic) {
    const launch = launchEnvironment(executable, env, platform)
    if (nodeExecutable(launch.env, resolution) || !await needsNode(executable)) return launch
  }
  const reasons: string[] = []
  try {
    env = mergeShellEnvironment(env, await userShellEnvironment(env, cwd, platform, context))
    checkCancelled(context.signal)
    if (!executable) {
      try { executable = resolveCodexExecutable('codex', { ...resolution, env }) } catch {
        reasons.push('用户 Shell: PATH 和 CODEX_INSTALL_DIR 中没有可执行的 codex')
      }
    }
  } catch (error: any) {
    checkCancelled(context.signal)
    reasons.push(`用户 Shell: ${error.message}`)
  }
  if (executable) {
    const launch = launchEnvironment(executable, env, platform)
    if (nodeExecutable(launch.env, resolution) || !await needsNode(executable)) return launch
  }

  const directories = await installDirectories(home, env, cwd, context, reasons)
  if (!executable) {
    for (const directory of directories) {
      checkCancelled(context.signal)
      try {
        executable = resolveCodexExecutable('codex', { ...resolution, env: { ...env, PATH: directory } })
        break
      } catch (error: any) {
        reasons.push(...error.message.split('\n').filter((line: string) => line.startsWith(directory + '/')))
      }
    }
  }
  if (!executable) {
    throw new Error(`${originalError?.message}\n${reasons.join('\n')}\n补充安装目录: ${directories.join(', ')}；没有可用的 codex`)
  }
  let launch = launchEnvironment(executable, env, platform)
  if (!nodeExecutable(launch.env, resolution) && await needsNode(executable)) {
    for (const directory of directories) {
      checkCancelled(context.signal)
      if (nodeExecutable({ ...env, PATH: directory }, resolution)) {
        launch = launchEnvironment(executable, { ...env, PATH: directory + (env.PATH ? ':' + env.PATH : '') }, platform)
        break
      }
    }
    if (!nodeExecutable(launch.env, resolution)) {
      throw new Error(`已找到 Codex CLI: ${executable}\nJavaScript 启动器需要 node，但 PATH、用户 Shell 和补充安装目录中没有可执行的 node。\n${reasons.join('\n')}\n请安装 Node.js 或修正 codexAgent.executable 对应的运行环境。`)
    }
  }
  checkCancelled(context.signal)
  return launch
}
