import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Readable } from 'stream'
import { codexEnvironment, environmentValue, executableEnvironment, executableFile, ExecutableContext, normalizeExecutable, resolveCodexExecutable } from './codex-executable'
import { packageManagerDirectories } from './codex-prefix'

export interface CodexLaunch {
  executable: string
  env: NodeJS.ProcessEnv
}

export interface DiscoveryContext extends ExecutableContext {
  signal?: AbortSignal
  shellTimeoutMs?: number
  prefixTimeoutMs?: number
  arch?: string
  /** Override host-level locations for filesystem-backed discovery tests. */
  systemDirectories?: string[]
  applicationDirectories?: string[]
  extensionDirectories?: string[]
}

// Import only settings needed by Codex and its runtime. In particular, never
// import shell NODE_OPTIONS, loader hooks or the internal originator override.
const SHELL_KEYS = [
  'CODEX_HOME', 'CODEX_SQLITE_HOME', 'CODEX_INSTALL_DIR', 'NVM_DIR',
  'HOMEBREW_PREFIX', 'NPM_CONFIG_PREFIX', 'npm_config_prefix',
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

function discoveryPaths (context: DiscoveryContext): path.PlatformPath {
  return context.paths || (context.platform === 'win32' ? path.win32 : path.posix)
}

function expandDirectory (value: string, home: string, cwd: string, paths: path.PlatformPath): string {
  value = normalizeExecutable(value)
  return paths.resolve(cwd, /^~[/\\]/.test(value) ? paths.join(home, value.slice(2)) : value)
}

async function installDirectories (home: string, env: NodeJS.ProcessEnv, cwd: string, context: DiscoveryContext, reasons: string[]): Promise<string[]> {
  const windows = context.platform === 'win32'
  const paths = discoveryPaths(context)
  const directories: string[] = []
  const codexHome = expandDirectory(environmentValue(env, 'CODEX_HOME', windows) || paths.join(home, '.codex'), home, cwd, paths)
  if (!windows) directories.push(paths.join(home, '.local', 'bin'))
  // Both package layouts have existed. Prefer the current bin/ entrypoint.
  directories.push(paths.join(codexHome, 'packages', 'standalone', 'current', 'bin'), paths.join(codexHome, 'packages', 'standalone', 'current'))
  if (windows) {
    const appData = environmentValue(env, 'APPDATA', true)
    if (appData) directories.push(paths.join(appData, 'npm'))
  } else directories.push(paths.join(home, '.npm-global', 'bin'))
  const npmPrefix = environmentValue(env, 'npm_config_prefix', windows) || environmentValue(env, 'NPM_CONFIG_PREFIX', windows)
  if (npmPrefix) {
    const prefix = expandDirectory(npmPrefix, home, cwd, paths)
    directories.push(windows ? prefix : paths.join(prefix, 'bin'))
  }
  if (!windows) {
    const brewPrefix = env.HOMEBREW_PREFIX
    if (brewPrefix) directories.push(paths.join(expandDirectory(brewPrefix, home, cwd, paths), 'bin'))
    const nvmRoots = [...new Set([env.NVM_DIR, paths.join(home, '.nvm')].filter((value): value is string => !!value))]
    for (const nvmRoot of nvmRoots) {
      const root = expandDirectory(nvmRoot, home, cwd, paths)
      directories.push(paths.join(root, 'current', 'bin'))
      const versions = paths.join(root, 'versions', 'node')
      try {
        const entries = await fs.promises.readdir(versions, { withFileTypes: true })
        entries.filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) && /^v\d+\.\d+\.\d+$/.test(entry.name))
          .sort((a, b) => b.name.localeCompare(a.name, 'en', { numeric: true }))
          .forEach(entry => directories.push(paths.join(versions, entry.name, 'bin')))
      } catch (error: any) { reasons.push(`NVM ${versions}: ${error.code || error.message}`) }
      checkCancelled(context.signal)
    }
  }
  const system: string[] = []
  if (windows) {
    const programFiles = environmentValue(env, 'ProgramFiles', true)
    const localAppData = environmentValue(env, 'LOCALAPPDATA', true)
    if (programFiles) system.push(paths.join(programFiles, 'nodejs'))
    if (localAppData) system.push(paths.join(localAppData, 'Programs', 'nodejs'))
  } else system.push('/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin', paths.join(home, '.linuxbrew', 'bin'))
  directories.push(...(context.systemDirectories ?? system))
  return [...new Set(directories)]
}

function desktopDirectories (home: string, context: DiscoveryContext): string[] {
  if (context.platform !== 'darwin') return []
  const paths = discoveryPaths(context)
  return (context.applicationDirectories ?? [paths.join(home, 'Applications'), '/Applications']).flatMap(root =>
    ['ChatGPT.app', 'Codex.app'].flatMap(app => [
      paths.join(root, app, 'Contents', 'Resources', 'codex-cli', 'bin'),
      paths.join(root, app, 'Contents', 'Resources'),
    ]))
}

async function ideDirectories (home: string, context: DiscoveryContext, reasons: string[]): Promise<string[]> {
  const paths = discoveryPaths(context)
  const arch = context.arch || process.arch
  const machine = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : undefined
  if (!machine) { reasons.push(`IDE: 不支持的架构 ${arch}`); return [] }
  const platform = context.platform!
  const platforms = [`${platform}-${machine}`, `${platform}-${arch}`]
  if (platform === 'win32') platforms.push(`windows-${machine}`)
  const roots = context.extensionDirectories ?? ['.vscode', '.vscode-insiders', '.vscode-server', '.vscode-server-insiders'].map(name => paths.join(home, name, 'extensions'))
  const extensions: { root: string; version: string }[] = []
  for (const root of roots) {
    checkCancelled(context.signal)
    try {
      for (const entry of await fs.promises.readdir(root, { withFileTypes: true })) {
        const match = /^openai\.chatgpt-(\d+\.\d+\.\d+)(?:-[a-z0-9.-]+)?$/.exec(entry.name)
        if (match && (entry.isDirectory() || entry.isSymbolicLink())) extensions.push({ root: paths.join(root, entry.name), version: match[1] })
      }
    } catch (error: any) { reasons.push(`IDE ${root}: ${error.code || error.message}`) }
  }
  extensions.sort((a, b) => b.version.localeCompare(a.version, 'en', { numeric: true }) || a.root.localeCompare(b.root, 'en'))
  return extensions.flatMap(extension => [...new Set(platforms)].map(platform => paths.join(extension.root, 'bin', platform)))
}

/** Resolve the CLI once; environment recovery must never replace a selected CLI. */
export async function resolveCodexLaunch (configured: string, context: DiscoveryContext = {}): Promise<CodexLaunch> {
  const platform = context.platform || process.platform
  const windows = platform === 'win32'
  let env = codexEnvironment(context.env || process.env)
  const home = context.home || environmentValue(env, windows ? 'USERPROFILE' : 'HOME', windows) || os.homedir()
  const cwd = context.cwd || process.cwd()
  const resolution = { ...context, platform, home, cwd }
  const paths = discoveryPaths(resolution)
  const automatic = !normalizeExecutable(configured) || normalizeExecutable(configured) === 'codex'
  const supported = windows || platform === 'linux' || platform === 'darwin'
  checkCancelled(context.signal)
  let executable: string | undefined
  let originalError: Error | undefined
  try { executable = resolveCodexExecutable(configured, { ...resolution, env }) } catch (error: any) {
    if (!automatic || !supported) throw error
    originalError = error
  }
  if (!supported || (windows && executable)) return launchEnvironment(executable!, env, platform)

  const missingNode = async (selected: string): Promise<boolean> => {
    const launch = launchEnvironment(selected, env, platform)
    return !windows && !nodeExecutable(launch.env, resolution) && await needsNode(selected)
  }
  // Explicit/custom CLIs retain their contract. Only missing Node may require
  // environment recovery; invalid paths/names have already failed above.
  if (executable && !automatic && !await missingNode(executable)) return launchEnvironment(executable, env, platform)
  const reasons: string[] = []
  if (!windows) {
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
  }
  if (executable && !await missingNode(executable)) return launchEnvironment(executable, env, platform)

  const directories = await installDirectories(home, env, cwd, resolution, reasons)
  // Validate only this candidate. Never re-enter automatic Windows scanning or
  // CODEX_INSTALL_DIR while iterating fallback directories.
  const select = (candidates: string[]): string | undefined => {
    for (const directory of candidates) {
      checkCancelled(context.signal)
      for (const name of windows ? ['codex.exe', 'codex.cmd'] : ['codex']) {
        const filename = paths.resolve(cwd, directory, name)
        try { executableFile(filename, resolution); return filename } catch (error: any) {
          reasons.push(`${filename}: ${error.code || error.message}`)
        }
      }
    }
    return undefined
  }
  if (!executable) executable = select(directories)
  if (!executable || await missingNode(executable)) {
    const searchPath = [environmentValue(env, 'PATH', windows), ...directories].filter(Boolean).join(windows ? ';' : ':')
    const prefixes = await packageManagerDirectories(executableEnvironment(env, searchPath, windows), resolution, reasons)
    checkCancelled(context.signal)
    directories.push(...prefixes)
    if (!executable) executable = select(prefixes)
  }
  if (!executable) {
    const applications = desktopDirectories(home, resolution)
    directories.push(...applications)
    executable = select(applications)
  }
  if (!executable) {
    const extensions = await ideDirectories(home, resolution, reasons)
    directories.push(...extensions)
    executable = select(extensions)
  }
  if (!executable) {
    throw new Error(`${originalError?.message}\n${reasons.join('\n')}\n补充安装目录: ${directories.join(', ')}；没有可用的 codex`)
  }
  let launch = launchEnvironment(executable, env, platform)
  if (await missingNode(executable)) {
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
