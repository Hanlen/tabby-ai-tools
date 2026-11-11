import { ChildProcessWithoutNullStreams, spawn } from 'child_process'
import { spawn as spawnWindowsLauncher } from 'cross-spawn'
import { EventEmitter } from 'events'
import * as readline from 'readline'
import * as path from 'path'
import { normalizeExecutable } from './codex-executable'
import { CodexLaunch, resolveCodexLaunch } from './codex-discovery'
import { checkCodexInstallation, codexHelperFailure, installationFailure, CodexCapabilities } from './codex-installation'
import { terminateCodexProcess } from './codex-process'
import { NativeSessionSpace, prepareSessionSpace, initializeNativeAuth, sessionEnvironment, codexSpaceArgs } from './session-space'

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
  private space?: NativeSessionSpace
  private capabilities: CodexCapabilities = {}
  private connected = false
  private discovery?: AbortController
  private stopping?: Promise<void>
  private launch?: CodexLaunch
  private excludedExecutables = new Set<string>()
  private recoveryAttempts = 0
  private recovering?: Promise<void>
  private fault?: Error
  private activeTurns = new Set<string>()
  private serverRequests = new Set<number>()
  private idleDisconnected = false
  /** Changes only after a process has initialized, never after a task retry. */
  generation = 0
  get installationRecoveryStopped (): boolean { return !!this.fault || this.recoveryAttempts >= 1 }

  get isConnected (): boolean { return this.connected }
  async waitUntilReady (): Promise<void> { if (this.ready) await this.ready }
  waitForCleanup (): Promise<void> { return this.stopping || Promise.resolve() }

  async refreshAuthentication (executable: string, space?: NativeSessionSpace): Promise<void> {
    if (!space?.native || space.engine !== 'codex') throw new Error('Select a private Codex space to copy the local login cache')
    await this.close()
    const resolved = await resolveCodexLaunch(normalizeExecutable(executable) || 'codex', { onInvalidExecutable: this.onInvalidExecutable })
    await prepareSessionSpace(space)
    if (!await initializeNativeAuth(space, resolved.env, { replaceExisting: true })) {
      throw new Error('本机没有可复用的登录缓存，请先在原始 CLI 登录；钥匙串登录需在所选空间重新登录。')
    }
    await this.connect(executable, space)
    const result = await this.request('account/read', { refreshToken: false })
    if (result.account?.type !== 'chatgpt') throw new Error('本机没有可复用的登录缓存，请先在原始 CLI 登录；钥匙串登录需在所选空间重新登录。')
  }

  async connect (executable: string, space?: NativeSessionSpace, capabilities: CodexCapabilities = {}): Promise<void> {
    executable = normalizeExecutable(executable) || 'codex'
    // The eager runtime has no space metadata; the panel later supplies the
    // explicit system space. Both use the same CLI home and must share discovery.
    if (this.recovering && this.executable === executable && this.space?.key === space?.key) return this.recovering
    const explicitRetry = this.fault && this.recoveryAttempts >= 1 && !this.activeTurns.size && !this.pending.size && !this.serverRequests.size
    if (this.ready && !explicitRetry && this.executable === executable && (this.space?.key || 'system:codex') === (space?.key || 'system:codex') && this.space?.native === space?.native && this.capabilities.codeModeTools === capabilities.codeModeTools && this.capabilities.sandboxedExecution === capabilities.sandboxedExecution) {
      if (this.connected && this.launch) {
        try { checkCodexInstallation(this.launch.executable, this.launch.companions || []) } catch (error: any) {
          this.recordInstallationFault(error)
          this.tryRecovery()
          if (this.recovering) return this.recovering
          throw error
        }
      }
      return this.ready
    }
    if (this.connected && this.activeTurns.size) throw new Error('Codex has active turns in this connection; wait for them before replacing its app-server')
    this.close()
    this.executable = executable
    this.space = space
    this.launch = undefined
    this.capabilities = { ...capabilities }
    this.excludedExecutables.clear()
    this.recoveryAttempts = 0
    this.fault = undefined
    this.idleDisconnected = false
    const discovery = new AbortController()
    this.discovery = discovery
    const ready = this.startWithRecovery(executable, discovery.signal, space).catch(error => {
      if (this.ready === ready) this.ready = undefined
      throw error
    })
    this.ready = ready
    return this.ready
  }

  private async startWithRecovery (executable: string, signal: AbortSignal, space?: NativeSessionSpace): Promise<void> {
    try { await this.start(executable, signal, space) } catch (error: any) {
      if (signal.aborted || !installationFailure(error) || this.recoveryAttempts >= 1) throw error
      this.recordInstallationFault(error)
      this.recoveryAttempts++
      this.fault = undefined
      try { await this.start(this.executable, signal, space) } catch (next: any) {
        this.fault = new Error(`${error.message}\nRecovery stopped after one rescan: ${next.message}`)
        throw this.fault
      }
    }
  }

  private recordInstallationFault (error: Error): void {
    if (this.fault) return
    this.fault = this.launch ? new Error(`${error.message}\nCLI: ${this.launch.executable}\nInstallation: ${path.dirname(this.launch.executable)}`) : error
    if (this.launch) this.excludedExecutables.add(this.launch.executable)
    this.emit('diagnostic', `${error.message}\nInstallation recovery waits for an idle, known turn boundary. Submitted operations are never replayed.\n`)
    void Promise.resolve().then(() => this.tryRecovery())
  }

  private tryRecovery (): void {
    if (!this.fault || this.recovering || !this.connected && !this.idleDisconnected || this.activeTurns.size || this.pending.size || this.serverRequests.size) return
    if (this.recoveryAttempts >= 1) {
      this.emit('recoveryFailed', new Error(`${this.fault.message}\nAutomatic installation recovery exhausted (one rescan). Select a complete CLI installation in Settings → AI Tools → Codex, then reconnect. Inspect terminal state before continuing.`))
      return
    }
    const signal = this.discovery?.signal
    if (!signal || signal.aborted) return
    const reason = this.fault
    this.recoveryAttempts++
    // Reserve the single flight before emitting disconnect (listeners may reconnect).
    const recovery = Promise.resolve().then(async () => {
      if (signal.aborted || this.discovery?.signal !== signal) throw new Error('Codex installation recovery was cancelled')
      this.disconnect(new Error(`${reason.message}\nRecovering connection only; no task or tool call will be replayed.`))
      this.idleDisconnected = false
      this.fault = undefined
      this.ready = recovery
      try {
        await this.start(this.executable, signal, this.space, true)
        this.emit('recovered')
      } catch (error: any) {
        if (signal.aborted) throw error
        const failure = new Error(`${reason.message}\nRecovery stopped after one rescan: ${error.message}\nSelect a complete CLI installation and reconnect. Inspect terminal state before continuing.`)
        this.fault = failure
        if (this.ready === recovery) this.ready = undefined
        this.emit('recoveryFailed', failure)
        throw failure
      }
    })
    this.recovering = recovery
    this.ready = recovery
    void recovery.catch(() => {}).finally(() => {
      if (this.recovering === recovery) { this.recovering = undefined; this.tryRecovery() }
    })
  }

  private readonly onInvalidExecutable = (configured: string): void => {
    this.executable = 'codex'
    this.emit('invalidExecutable', configured)
    this.emit('diagnostic', `Configured Codex CLI is unavailable: ${configured}\nCleared selector; searching automatically. No task will be replayed.\n`)
  }

  private async start (executable: string, signal: AbortSignal, space?: NativeSessionSpace, recovered = false): Promise<void> {
    const resolved = await resolveCodexLaunch(executable, { ...this.capabilities, signal, excludedExecutables: this.excludedExecutables, onInvalidExecutable: this.onInvalidExecutable })
    if (signal.aborted) throw new Error('Codex app-server was closed during CLI discovery')
    this.launch = resolved
    if (space) await prepareSessionSpace(space)
    if (this.stopping) await this.stopping
    if (signal.aborted) throw new Error('Codex app-server was closed during CLI discovery')
    if (!recovered) await initializeNativeAuth(space, resolved.env)
    if (signal.aborted) throw new Error('Codex app-server was closed during login cache initialization')
    checkCodexInstallation(resolved.executable, resolved.companions || [])
    executable = resolved.executable
    // Native binaries always use an absolute path and direct argument arrays.
    // Only Windows batch launchers need cmd.exe; cross-spawn escapes its command
    // line (including paths with spaces) and preserves all three stdio pipes.
    const launch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable) ? spawnWindowsLauncher : spawn
    const child = launch(executable, [...codexSpaceArgs(space), 'app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      env: sessionEnvironment(space, resolved.env),
      detached: process.platform !== 'win32',
    }) as ChildProcessWithoutNullStreams
    let stderr = ''
    const failure = (error: Error): Error => new Error(`${error.message}\nCodex CLI: ${executable}${stderr.trim() ? `\n${stderr.trim()}` : ''}\n请检查 Settings → AI Tools → codexAgent.executable。`)
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
      if (codexHelperFailure(stderr)) this.recordInstallationFault(new Error(`Codex CLI: ${executable}\n${stderr.trim()}`))
    })
    child.stdin.on('error', streamError)
    child.on('error', error => {
      let reason = failure(error)
      try { checkCodexInstallation(executable, resolved.companions || []) } catch (missing: any) { reason = missing }
      this.disconnect(reason, child)
    })
    let exitTimer: ReturnType<typeof setTimeout> | undefined
    const exited = (code: number | null, signal: NodeJS.Signals | null): Error => failure(new Error(`Codex app-server exited (${code ?? signal})`))
    child.on('exit', (code, signal) => {
      // Normally 'close' immediately follows 'exit' after draining stderr. A
      // surviving descendant can hold the pipes open forever, even with no RPC
      // outstanding; in that case start group cleanup without waiting for EOF.
      exitTimer = setTimeout(() => this.disconnect(exited(code, signal), child), 100)
    })
    child.on('close', (code, signal) => {
      clearTimeout(exitTimer)
      this.disconnect(exited(code, signal), child, true)
    })
    try {
      await this.requestRaw('initialize', {
        clientInfo: { name: 'tabby_codex_agent', title: 'Tabby AI Tools', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      })
    } catch (error: any) {
      if (this.process !== child) throw error
      const reason = failure(error)
      this.disconnect(reason, child)
      throw reason
    }
    if (this.process !== child) throw new Error('Codex app-server connection was replaced')
    if (this.fault) { const error = this.fault; this.disconnect(error, child); throw error }
    this.notify('initialized', {})
    this.connected = true
    this.idleDisconnected = false
    this.generation++
    if (!recovered) this.emit('connected')
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
      const thread = message.result?.thread
      if (typeof thread?.id === 'string' && (thread.status?.type === 'active' ||
          !thread.status?.type && thread.turns?.some((turn: any) => turn.status === 'inProgress'))) this.activeTurns.add(thread.id)
      if (message.error) pending.reject(Object.assign(new Error(message.error.message), { rpcRejected: true }))
      else pending.resolve(message.result)
      if (message.error && codexHelperFailure(message.error.message)) this.recordInstallationFault(new Error(message.error.message))
      this.tryRecovery()
      return
    }
    if (message.method) {
      const p = message.params
      if (message.method === 'turn/started') this.activeTurns.add(p.threadId)
      if (message.method === 'turn/completed') this.activeTurns.delete(p.threadId)
      if (message.id !== undefined) this.serverRequests.add(message.id)
      if (message.method === 'serverRequest/resolved') this.serverRequests.delete(p.requestId)
      const error = message.method === 'error' ? p?.error : message.method === 'turn/completed' ? p?.turn?.error : undefined
      if (error && codexHelperFailure([error.message, error.additionalDetails].filter(Boolean).join('\n'))) this.recordInstallationFault(new Error([error.message, error.additionalDetails].filter(Boolean).join('\n')))
      this.emit('event', message)
      this.tryRecovery()
    }
  }

  private disconnect (error: Error, child = this.process, closed = false): void {
    if (!child || this.process !== child) return
    this.idleDisconnected = this.connected && !this.activeTurns.size && !this.pending.size && !this.serverRequests.size
    if (this.connected && installationFailure(error)) this.recordInstallationFault(error)
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
    this.serverRequests.clear()
    const stopping = terminateCodexProcess(child, { closed })
    this.stopping = stopping
    // Retain a failed cleanup as a barrier: a reconnect must not create a
    // second server when termination of the previous one could not be confirmed.
    stopping.then(() => {
      if (this.stopping === stopping) this.stopping = undefined
    }, error => this.emit('diagnostic', error.message))
    this.emit('disconnected', error)
    this.tryRecovery()
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
    // Admission is closed after a confirmed fault. The current turn may finish,
    // but another request must not start work on the invalid installation.
    if (this.fault && ['turn/start', 'turn/steer', 'thread/start', 'thread/resume'].includes(method)) throw new Error(`${this.fault.message}\nConnection recovery is pending or exhausted; no new task was sent.`)
    if (this.launch && ['turn/start', 'turn/steer', 'thread/start', 'thread/resume'].includes(method)) {
      try { checkCodexInstallation(this.launch.executable, this.launch.companions || []) } catch (error: any) {
        this.recordInstallationFault(error)
        this.tryRecovery()
        throw new Error(`${error.message}\nInstallation recovery is pending or exhausted; no new task was sent.`)
      }
    }
    if (method === 'turn/start') this.activeTurns.add(params.threadId)
    try { return await this.requestRaw(method, params) } catch (error: any) {
      // A transport loss / timeout leaves execution unknown. Only a definite RPC
      // rejection establishes that this admission did not start a turn.
      if (method === 'turn/start' && error.rpcRejected) { this.activeTurns.delete(params.threadId); this.tryRecovery() }
      throw error
    }
  }

  notify (method: string, params: any = {}): void {
    this.process?.stdin.write(JSON.stringify({ method, params }) + '\n')
  }

  respond (id: number, result: any): void {
    this.serverRequests.delete(id)
    this.process?.stdin.write(JSON.stringify({ id, result }) + '\n')
  }

  respondError (id: number, message: string): void {
    this.serverRequests.delete(id)
    this.process?.stdin.write(JSON.stringify({ id, error: { code: -32601, message } }) + '\n')
  }

  close (): Promise<void> {
    this.discovery?.abort()
    this.discovery = undefined
    this.ready = undefined
    this.activeTurns.clear()
    this.disconnect(new Error('Codex app-server was closed'))
    return this.stopping || Promise.resolve()
  }
}
