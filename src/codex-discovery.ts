import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
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

function checkCancelled (signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Codex app-server was closed during CLI discovery')
}

function launchEnvironment (executable: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): CodexLaunch {
  // Keep the launcher path (not its symlink target): npm puts node beside codex.
  // This also makes explicit NVM paths work with #!/usr/bin/env node.
  return {
    executable,
    env: platform === 'linux' || platform === 'darwin'
      ? { ...env, PATH: path.dirname(executable) + (env.PATH ? ':' + env.PATH : '') }
      : env,
  }
}

/** Read only PATH on a dedicated pipe; shell startup banners never become data. */
function userShellPath (env: NodeJS.ProcessEnv, cwd: string, platform: NodeJS.Platform, context: DiscoveryContext): Promise<string> {
  return new Promise((resolve, reject) => {
    const shell = env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
    const name = path.basename(shell)
    if (!path.isAbsolute(shell) || !['bash', 'zsh', 'sh', 'dash', 'ksh', 'fish'].includes(name)) {
      reject(new Error(`${shell}: 不支持的用户 Shell；继续检查安装目录`))
      return
    }
    const command = name === 'fish'
      ? "printf '%s\\0' (string join : $PATH) >&3"
      : "printf '%s\\0' \"$PATH\" >&3"
    const child = spawn(shell, ['-ilc', command], {
      cwd, env, detached: true, shell: false,
      stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
    })
    let settled = false
    let output = Buffer.alloc(0)
    const kill = (): void => {
      // Startup scripts may leave descendants holding the extra pipe open.
      // A separate process group lets timeout/cancellation stop those too.
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }
    const finish = (error?: Error, value?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      context.signal?.removeEventListener('abort', abort)
      kill()
      if (error) reject(error)
      else resolve(value!)
    }
    const abort = (): void => finish(new Error('Codex app-server was closed during CLI discovery'))
    const timer = setTimeout(() => finish(new Error(`${shell}: 探测超时（${context.shellTimeoutMs ?? 3000} ms）`)), context.shellTimeoutMs ?? 3000)
    context.signal?.addEventListener('abort', abort, { once: true })
    if (context.signal?.aborted) abort()
    child.on('error', (error: NodeJS.ErrnoException) => finish(new Error(`${shell}: ${error.code || error.message}`)))
    child.stdio[3]!.on('error', error => finish(error))
    child.stdio[3]!.on('data', (data: Buffer) => {
      if (settled) return
      if (output.length + data.length > 65536) {
        finish(new Error(`${shell}: PATH 探测输出超过 64 KiB`))
        return
      }
      output = Buffer.concat([output, data])
    })
    child.on('close', (code, signal) => {
      if (settled) return
      const value = output.toString('utf8')
      if (code !== 0) finish(new Error(`${shell}: 探测退出（${code ?? signal}）`))
      else if (!value.endsWith('\0') || value.slice(0, -1).includes('\0') || !value.slice(0, -1).trim()) {
        finish(new Error(`${shell}: 未返回有效 PATH`))
      } else finish(undefined, value.slice(0, -1))
    })
  })
}

/** Default-name fallback only. Explicit paths and custom names keep their errors. */
export async function resolveCodexLaunch (configured: string, context: DiscoveryContext = {}): Promise<CodexLaunch> {
  const platform = context.platform || process.platform
  const env = codexEnvironment(context.env || process.env)
  const home = context.home || env.HOME || os.homedir()
  const cwd = context.cwd || process.cwd()
  const resolution = { ...context, platform, env, home, cwd }
  checkCancelled(context.signal)
  let originalError: Error
  try {
    return launchEnvironment(resolveCodexExecutable(configured, resolution), env, platform)
  } catch (error: any) {
    const value = normalizeExecutable(configured)
    if ((value && value !== 'codex') || (platform !== 'linux' && platform !== 'darwin')) throw error
    originalError = error
  }

  const reasons: string[] = []
  let fallbackEnv = env
  try {
    const shellPath = await userShellPath(env, cwd, platform, context)
    checkCancelled(context.signal)
    const shellEnv = { ...env, PATH: shellPath + (env.PATH ? ':' + env.PATH : '') }
    fallbackEnv = shellEnv
    try {
      const executable = resolveCodexExecutable('codex', { ...resolution, env: shellEnv })
      return launchEnvironment(executable, shellEnv, platform)
    } catch { reasons.push('用户 Shell: PATH 中没有可执行的 codex') }
  } catch (error: any) {
    checkCancelled(context.signal)
    reasons.push(`用户 Shell: ${error.message}`)
  }

  // NVM need not be loaded by shell -lc (or even by -ilc). Discover its actual
  // installed versions without sourcing nvm.sh or hardcoding a Node version.
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
  for (const directory of [...new Set(directories)]) {
    checkCancelled(context.signal)
    // Search this directory only; never select a different explicit/custom CLI.
    try {
      const executable = resolveCodexExecutable('codex', { ...resolution, env: { ...env, PATH: directory } })
      return launchEnvironment(executable, fallbackEnv, platform)
    } catch (error: any) {
      const rejected = error.message.split('\n').filter((line: string) => line.startsWith(directory + '/'))
      reasons.push(...rejected)
    }
  }
  throw new Error(`${originalError.message}\n${reasons.join('\n')}\n补充安装目录: ${directories.join(', ')}；没有可用的 codex`)
}
