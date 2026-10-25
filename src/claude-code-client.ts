import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { spawn as spawnWindowsLauncher } from 'cross-spawn'
import * as os from 'os'
import * as path from 'path'
import { executableFile, environmentValue, normalizeExecutable, ExecutableContext } from './codex-executable'
import { terminateCodexProcess } from './codex-process'
import { redactMemory } from './task-memory'

/** Resolve the user's own, unmodified CLI; never download a binary or read its credentials. */
export function resolveClaudeExecutable (configured = '', context: ExecutableContext = {}): string {
  const windows = (context.platform || process.platform) === 'win32'
  const paths = context.paths || (windows ? path.win32 : path.posix)
  const env = context.env || process.env
  const home = context.home || os.homedir()
  const cwd = context.cwd || process.cwd()
  let command = normalizeExecutable(configured) || 'claude'
  if (/^~[/\\]/.test(command)) command = paths.join(home, command.slice(2))
  const explicit = paths.isAbsolute(command) || /[/\\]/.test(command)
  const extensions = windows && !paths.extname(command) ? ['.exe', '.cmd', '.bat', '.com'] : ['']
  const directories = (environmentValue(env, 'PATH', windows) || '').split(windows ? ';' : ':').filter(Boolean)
  if (command === 'claude') directories.push(paths.join(home, '.local', 'bin'), paths.dirname(process.execPath),
    ...(windows ? [paths.join(environmentValue(env, 'APPDATA', true) || paths.join(home, 'AppData', 'Roaming'), 'npm')]
      : ['/opt/homebrew/bin', '/usr/local/bin', paths.join(home, '.npm-global', 'bin')]))
  const candidates = explicit ? [paths.resolve(cwd, command)] : directories.flatMap(directory => extensions.map(extension => paths.resolve(cwd, normalizeExecutable(directory), command + extension)))
  for (const candidate of candidates) {
    try { executableFile(candidate, context); return candidate } catch { /* Try the next installation. */ }
  }
  throw new Error('找不到 Claude Code CLI；请先安装官方 CLI，或在 Settings → AI Tools → Claude Code 中填写有效的可执行文件路径。')
}

export interface ClaudeProcessOptions {
  executable: string
  args: string[]
  cwd: string
  signal: AbortSignal
  input?: string
  timeoutMs?: number
  onLine?: (line: string) => void
  env?: NodeJS.ProcessEnv
}

/** A bounded JSONL pipe with cancellation that waits for the owned process tree. */
export async function runClaudeProcess (options: ClaudeProcessOptions): Promise<string> {
  if (options.signal.aborted) throw new Error('请求已停止')
  const launch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(options.executable) ? spawnWindowsLauncher : spawn
  // Preserve official authentication choices, including API/cloud credentials. Never copy or parse tokens.
  const child = launch(options.executable, options.args, {
    cwd: options.cwd, env: options.env || process.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    windowsHide: true, detached: process.platform !== 'win32',
  }) as ChildProcessWithoutNullStreams
  let output = '', pending = '', stderr = '', closed = false, failure: Error | undefined
  let stopping: Promise<void> | undefined
  const stop = (error: Error) => {
    failure = failure || error
    if (!stopping) stopping = terminateCodexProcess(child, { closed }).catch(cleanup => { failure = cleanup })
  }
  const abort = () => stop(new Error('请求已停止'))
  options.signal.addEventListener('abort', abort, { once: true })
  const timer = options.timeoutMs ? setTimeout(() => stop(new Error('Claude Code CLI 响应超时')), options.timeoutMs) : undefined
  try {
    await new Promise<void>((resolve, reject) => {
      child.on('error', reject)
      child.stdin.on('error', error => stop(error))
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-8000) })
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        try {
          if (options.onLine) {
            pending += chunk
            if (Buffer.byteLength(pending) > 4 * 1024 * 1024) throw new Error('Claude Code 输出行过大')
            let newline: number
            while ((newline = pending.indexOf('\n')) >= 0) {
              const line = pending.slice(0, newline).trim()
              pending = pending.slice(newline + 1)
              if (line) options.onLine(line)
            }
          } else {
            output += chunk
            if (Buffer.byteLength(output) > 4 * 1024 * 1024) throw new Error('Claude Code 输出过大')
          }
        } catch (error: any) { stop(error) }
      })
      child.once('close', (code, signal) => {
        closed = true
        try {
          if (!failure && pending.trim()) options.onLine?.(pending.trim())
          if (!failure && code !== 0) failure = new Error(`Claude Code CLI 退出（${code ?? signal}）：${redactMemory(stderr, 2000)}`)
        } catch (error: any) { failure = error }
        resolve()
      })
      if (options.signal.aborted) abort()
      child.stdin.end(options.input || '')
    })
    if (stopping) await stopping
    if (failure) throw failure
    return output
  } finally {
    clearTimeout(timer)
    options.signal.removeEventListener('abort', abort)
    if (!closed) await terminateCodexProcess(child).catch(() => undefined)
  }
}

export async function inspectClaudeCode (configured: string, cwd: string, signal: AbortSignal): Promise<string> {
  const executable = resolveClaudeExecutable(configured)
  const run = (args: string[]) => runClaudeProcess({ executable, args, cwd, signal, timeoutMs: 15000 })
  const help = await run(['--help'])
  for (const flag of ['--tools', '--strict-mcp-config', '--setting-sources', '--disable-slash-commands', '--append-system-prompt-file', '--include-partial-messages', '--system-prompt-snapshot']) {
    if (!help.includes(flag)) throw new Error(`Claude Code CLI 缺少 ${flag}；请更新官方 CLI 后重试。`)
  }
  let auth: any
  try { auth = JSON.parse(await run(['auth', 'status'])) } catch (error: any) {
    if (signal.aborted) throw error
    throw new Error('无法确认 Claude Code 登录状态；请在本机终端运行 claude auth login，再用 claude auth status 检查。')
  }
  if (auth.loggedIn !== true) throw new Error('Claude Code 尚未登录；请在本机终端运行 claude auth login 完成官方登录。')
  return executable
}
