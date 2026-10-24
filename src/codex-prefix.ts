import { ChildProcessWithoutNullStreams, spawn } from 'child_process'
import { spawn as spawnWindowsLauncher } from 'cross-spawn'
import * as path from 'path'
import { ExecutableContext, executableEnvironment, environmentValue, resolveCodexExecutable } from './codex-executable'
import { terminateCodexProcess } from './codex-process'

export interface PrefixContext extends ExecutableContext {
  signal?: AbortSignal
  prefixTimeoutMs?: number
}

/** Query an installed package manager, never a shell, installer or model. */
async function prefix (command: string, args: string[], env: NodeJS.ProcessEnv, context: PrefixContext): Promise<string> {
  if (context.signal?.aborted) throw new Error('Codex app-server was closed during CLI discovery')
  const windows = (context.platform || process.platform) === 'win32'
  const paths = context.paths || (windows ? path.win32 : path.posix)
  const executable = resolveCodexExecutable(command, { ...context, env })
  const delimiter = windows ? ';' : ':'
  env = executableEnvironment(env, paths.dirname(executable) + delimiter + (environmentValue(env, 'PATH', windows) || ''), windows)
  return new Promise((resolve, reject) => {
    const launch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable) ? spawnWindowsLauncher : spawn
    const child = launch(executable, args, {
      cwd: context.home, env, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams
    child.stdin.end()
    let output = Buffer.alloc(0)
    let settled = false
    const finish = async (error?: Error, result?: string, closed = false): Promise<void> => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      context.signal?.removeEventListener('abort', abort)
      if (error) {
        // Kill the entire probe tree, including Node behind npm.cmd. Cleanup is
        // bounded even if a descendant keeps stdout open after the parent exits.
        try { await terminateCodexProcess(child, { env, closed, graceMs: 0, killTimeoutMs: 500 }) } catch { /* Report the probe failure. */ }
      }
      child.stdout.destroy()
      child.stderr.destroy()
      if (error) reject(error)
      else resolve(result!)
    }
    const abort = (): void => { void finish(new Error('Codex app-server was closed during CLI discovery')) }
    const timer = setTimeout(() => { void finish(new Error('prefix 探测超时')) }, context.prefixTimeoutMs ?? 2000)
    context.signal?.addEventListener('abort', abort, { once: true })
    if (context.signal?.aborted) abort()
    child.on('error', (error: NodeJS.ErrnoException) => { void finish(new Error(error.code || 'prefix 探测失败')) })
    child.stdin.on('error', () => { /* An early exit is handled by close/error. */ })
    child.stdout.on('error', () => { void finish(new Error('prefix 输出管道错误')) })
    child.stderr.on('error', () => { void finish(new Error('prefix 错误管道错误')) })
    child.stderr.resume()
    child.stdout.on('data', (data: Buffer) => {
      if (settled) return
      if (output.length + data.length > 16384) void finish(new Error('prefix 输出超过 16 KiB'))
      else output = Buffer.concat([output, data])
    })
    child.on('close', code => {
      if (settled) return
      const value = output.toString('utf8').trim()
      if (code !== 0) void finish(new Error(`prefix 退出码 ${code}`), undefined, true)
      else if (!value || /[\r\n\0]/.test(value) || !paths.isAbsolute(value)) void finish(new Error('prefix 未返回单行绝对路径'), undefined, true)
      else void finish(undefined, value)
    })
  })
}

export async function packageManagerDirectories (env: NodeJS.ProcessEnv, context: PrefixContext, reasons: string[]): Promise<string[]> {
  const windows = (context.platform || process.platform) === 'win32'
  const paths = context.paths || (windows ? path.win32 : path.posix)
  // Independent, read-only queries run concurrently and each has a fixed limit.
  const managers = windows ? ['npm'] : ['brew', 'npm']
  const results = await Promise.all(managers.map(async manager => {
    try {
      const value = await prefix(manager, manager === 'brew' ? ['--prefix'] : ['prefix', '-g'], env, context)
      return windows ? value : paths.join(value, 'bin')
    } catch (error: any) {
      // Missing commands may contain inherited PATH in their resolver errors;
      // report only probe status, never manager output or environment contents.
      reasons.push(`${manager}: ${error.message.includes('PATH') ? '未找到 prefix 查询命令' : error.message}`)
      return undefined
    }
  }))
  return results.filter((value): value is string => !!value)
}
