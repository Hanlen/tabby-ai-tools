import { ChildProcessWithoutNullStreams, spawn } from 'child_process'
import { spawn as spawnWindowsLauncher } from 'cross-spawn'
import { EventEmitter } from 'events'
import * as readline from 'readline'
import { normalizeExecutable } from './codex-executable'
import { resolveCodexLaunch } from './codex-discovery'

export interface RpcMessage {
  id?: number
  method?: string
  params?: any
  result?: any
  error?: { message: string; code?: number }
}

/** One long-lived app-server process for the Tabby window. */
export class CodexClient extends EventEmitter {
  private process?: ChildProcessWithoutNullStreams
  private lines?: readline.Interface
  private ready?: Promise<void>
  private nextId = 0
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private executable = ''
  private connected = false
  private discovery?: AbortController

  get isConnected (): boolean { return this.connected }

  async connect (executable: string): Promise<void> {
    executable = normalizeExecutable(executable) || 'codex'
    if (this.ready && this.executable === executable) return this.ready
    this.close()
    this.executable = executable
    const discovery = new AbortController()
    this.discovery = discovery
    const ready = this.start(executable, discovery.signal).catch(error => {
      if (this.ready === ready) this.ready = undefined
      throw error
    })
    this.ready = ready
    return this.ready
  }

  private async start (executable: string, signal: AbortSignal): Promise<void> {
    const resolved = await resolveCodexLaunch(executable, { signal })
    if (signal.aborted) throw new Error('Codex app-server was closed during CLI discovery')
    executable = resolved.executable
    // Native binaries always use an absolute path and direct argument arrays.
    // Only Windows batch launchers need cmd.exe; cross-spawn escapes its command
    // line (including paths with spaces) and preserves all three stdio pipes.
    const launch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable) ? spawnWindowsLauncher : spawn
    const child = launch(executable, ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      env: resolved.env,
    }) as ChildProcessWithoutNullStreams
    let stderr = ''
    const failure = (error: Error): Error => new Error(`${error.message}\nCodex CLI: ${executable}${stderr.trim() ? `\n${stderr.trim()}` : ''}\n请检查 Settings → Codex AI → codexAgent.executable。`)
    const streamError = (error: NodeJS.ErrnoException): void => {
      // A process that exits during startup may close stdin before its stderr
      // has drained. Let 'close' report the exit and the actual CLI error.
      if (error.code !== 'EPIPE') this.disconnect(failure(error), child)
    }
    this.process = child
    this.lines = readline.createInterface({ input: child.stdout })
    this.lines.on('line', line => { if (this.process === child) this.receive(line) })
    child.stderr.on('data', data => {
      if (this.process !== child) return
      stderr = (stderr + String(data)).slice(-8192)
      this.emit('diagnostic', String(data))
    })
    child.stdin.on('error', streamError)
    child.on('error', error => this.disconnect(failure(error), child))
    // Unlike 'exit', 'close' runs after stdout/stderr have finished.
    child.on('close', (code, signal) => this.disconnect(failure(new Error(`Codex app-server exited (${code ?? signal})`)), child))
    try {
      await this.requestRaw('initialize', {
        clientInfo: { name: 'tabby_codex_agent', title: 'Tabby Codex Agent', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      })
    } catch (error: any) {
      if (this.process !== child) throw error
      const reason = failure(error)
      this.disconnect(reason, child)
      throw reason
    }
    if (this.process !== child) throw new Error('Codex app-server connection was replaced')
    this.notify('initialized', {})
    this.connected = true
    this.emit('connected')
  }

  private receive (line: string): void {
    let message: RpcMessage
    try { message = JSON.parse(line) } catch {
      this.emit('diagnostic', `Invalid app-server message: ${line}`)
      return
    }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
      return
    }
    if (message.method) this.emit('event', message)
  }

  private disconnect (error: Error, child = this.process): void {
    if (!child || this.process !== child) return
    this.process = undefined
    this.connected = false
    this.ready = undefined
    this.lines?.close()
    this.lines = undefined
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
    child.stdin.destroy()
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32' && child.pid) {
        // npm .cmd launchers own a child process; terminate the whole tree.
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
        killer.on('error', () => { child.kill() })
        killer.on('close', code => { if (code !== 0) child.kill() })
      } else child.kill()
    }
    this.emit('disconnected', error)
  }

  private requestRaw (method: string, params: any = {}): Promise<any> {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin.writable) return reject(new Error('Codex app-server is unavailable'))
      const child = this.process
      const timer = setTimeout(() => {
        this.disconnect(new Error(`Codex app-server did not answer ${method} within 60 seconds`), child)
      }, 60000)
      this.pending.set(id, { resolve, reject, timer })
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
        if (error && (error as NodeJS.ErrnoException).code !== 'EPIPE') this.disconnect(error, child)
      })
    })
  }

  async request (method: string, params: any = {}): Promise<any> {
    if (!this.ready) throw new Error('Codex app-server is not connected')
    await this.ready
    return this.requestRaw(method, params)
  }

  notify (method: string, params: any = {}): void {
    this.process?.stdin.write(JSON.stringify({ method, params }) + '\n')
  }

  respond (id: number, result: any): void {
    this.process?.stdin.write(JSON.stringify({ id, result }) + '\n')
  }

  respondError (id: number, message: string): void {
    this.process?.stdin.write(JSON.stringify({ id, error: { code: -32601, message } }) + '\n')
  }

  close (): void {
    this.discovery?.abort()
    this.discovery = undefined
    this.ready = undefined
    this.disconnect(new Error('Codex app-server was closed'))
  }
}
