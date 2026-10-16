import { ChildProcessWithoutNullStreams, spawn } from 'child_process'
import * as path from 'path'
import { environmentValue } from './codex-executable'

export interface TerminationContext {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  graceMs?: number
  killTimeoutMs?: number
  closed?: boolean
}

export function windowsTaskkillPath (env: NodeJS.ProcessEnv = process.env): string {
  const root = environmentValue(env, 'SystemRoot', true) || environmentValue(env, 'WINDIR', true)
  if (!root || !path.win32.isAbsolute(root)) throw new Error('无法定位 taskkill.exe：SystemRoot / WINDIR 未设置为绝对路径')
  return path.win32.join(root, 'System32', 'taskkill.exe')
}

/** Wait for the owned process to close; never allow an unbounded shutdown. */
export async function terminateCodexProcess (child: ChildProcessWithoutNullStreams, context: TerminationContext = {}): Promise<void> {
  if (!child.pid) return
  const platform = context.platform || process.platform
  const graceMs = context.graceMs ?? 1000
  const killTimeoutMs = context.killTimeoutMs ?? 2000
  let closed = !!context.closed
  let resolveClosed: () => void
  const didClose = new Promise<void>(resolve => { resolveClosed = resolve })
  const onClose = (): void => { closed = true; resolveClosed() }
  if (closed) resolveClosed!()
  else child.once('close', onClose)
  const wait = async (ms: number): Promise<boolean> => {
    if (closed) return true
    let timer: ReturnType<typeof setTimeout>
    try { await Promise.race([didClose, new Promise<void>(resolve => { timer = setTimeout(resolve, ms) })]) }
    finally { clearTimeout(timer!) }
    return closed
  }
  try {
    if (platform === 'win32') {
      if (closed) return
      // Do not close stdin first: an exiting cmd.exe could orphan its children
      // before taskkill has traversed the tree. An absolute path works sans PATH.
      await new Promise<void>((resolve, reject) => {
        let killer: ReturnType<typeof spawn>
        try {
          killer = spawn(windowsTaskkillPath(context.env), ['/pid', String(child.pid), '/t', '/f'], {
            windowsHide: true, stdio: 'ignore', shell: false, env: context.env || process.env,
          })
        } catch (error) { reject(error); return }
        const timer = setTimeout(() => {
          killer.kill()
          reject(new Error('taskkill.exe 超时；无法确认旧 Codex 进程树已退出'))
        }, killTimeoutMs)
        killer.once('error', error => { clearTimeout(timer); reject(error) })
        killer.once('close', code => {
          clearTimeout(timer)
          if (code === 0 || closed) resolve()
          else reject(new Error(`taskkill.exe 退出码 ${code}；无法确认旧 Codex 进程树已退出`))
        })
      })
      if (!await wait(killTimeoutMs)) throw new Error('强制终止后 Codex 管道仍未关闭')
    } else {
      // The app-server is spawned as its own process group, including npm's
      // JavaScript launcher and any commands owned by that server.
      const signalGroup = (signal: NodeJS.Signals): void => {
        try { process.kill(-child.pid!, signal) } catch (error: any) {
          if (error.code !== 'ESRCH') throw error
        }
      }
      const groupExists = (): boolean => {
        try { process.kill(-child.pid!, 0); return true } catch (error: any) {
          if (error.code === 'ESRCH') return false
          throw error
        }
      }
      signalGroup('SIGTERM')
      child.stdin.destroy()
      await wait(graceMs)
      // Also kill surviving descendants if the group leader closed early.
      if (groupExists()) signalGroup('SIGKILL')
      if (!await wait(killTimeoutMs)) throw new Error('SIGKILL 后旧 Codex 进程仍未退出；已阻止启动新服务')
    }
  } catch (error: any) {
    try { child.kill('SIGKILL') } catch { /* Keep the original cleanup error. */ }
    throw new Error(`Codex 服务回收失败：${error.message}`)
  } finally {
    child.off('close', onClose)
    child.stdin.destroy()
    child.stdout.destroy()
    child.stderr.destroy()
  }
}
