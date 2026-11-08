import { Injectable, OnDestroy } from '@angular/core'
import { AppService, BaseTabComponent, SplitTabComponent, PlatformService, ConfigService } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { BehaviorSubject, Subscription } from 'rxjs'
import { CodexTerminalOutputService } from './terminal-output.service'
import { TabbyCapabilitiesService } from './tabby-capabilities.service'
import * as os from 'os'
import * as path from 'path'
import { StreamTokens } from './terminal-stream'
import { TerminalLogStore } from './terminal-log-store'
import { isIP } from 'net'
import { WorkflowTarget, redactMemory, observationFingerprint } from './task-memory'
import { SudoWorkflowLease } from './sudo-workflow'
import { TABBY_MUTATIONS, TABBY_OPERATIONS } from './tabby-operations'
import { matchesProcess, terminalKeySequence, terminalInteractionState } from './terminal-keys'
import { AttachmentTransferService } from './attachment-transfer.service'
import { TransferTarget } from './attachment-transport'
import { runAttachmentPty } from './attachment-pty'
import { RemoteProcessIdentity, verifyRemoteProcess } from './remote-process'
import { TERMINAL_INPUT_MAX_LENGTH } from './terminal-limits'

export interface ControlledTab { tabId: string; title: string; owner: string; command: string; startedAt: number }
export interface TabToolContext {
  owner: string
  logScope?: string
  signal?: AbortSignal
  readOnly?: boolean
  sudoLease?: boolean
}

interface ControlState extends ControlledTab {
  tab: BaseTerminalTabComponent<any>
  originalSendInput: BaseTerminalTabComponent<any>['sendInput']
  allowInput: boolean
  session: BaseTerminalTabComponent<any>['session']
  emptyChecks: number
  observedProcess: boolean
  completion?: 'running' | 'ended' | 'prompt'
  automaticCompletion: boolean
  subscriptions: Subscription
  expectedProcess?: string
  remoteProcess?: RemoteProcessIdentity
  timer?: ReturnType<typeof setTimeout>
}

export { TAB_TOOLS } from './tab-tool-definitions'

@Injectable()
export class TabbyTabToolsService implements OnDestroy {
  readonly controls$ = new BehaviorSubject<ControlledTab[]>([])
  private streamTokens = new StreamTokens()
  private logs?: TerminalLogStore
  private captures = new Map<string, { owner: string; scope: string; tab: BaseTerminalTabComponent<any>; stream: string; logId: string }>()
  private sudoLeases = new Map<string, Map<BaseTerminalTabComponent<any>, { lease: SudoWorkflowLease; session: any }>>()
  private controlled = new Map<BaseTerminalTabComponent<any>, ControlState>()
  private completionRevisions = new WeakMap<BaseTerminalTabComponent<any>, number>()
  private completedCommands = new WeakMap<BaseTerminalTabComponent<any>, any>()
  private completionWatchers = new Map<BaseTerminalTabComponent<any>, Subscription>()
  private ids = new WeakMap<BaseTabComponent, string>()
  private nextId = 0
  private controlIds = new WeakMap<Element, string>()
  private nextControlId = 0
  private windowControls = new Map<string, { element: Element; root: Element }>()
  private tracked = new Set<BaseTerminalTabComponent<any>>()
  private subscriptions = new Subscription()

  constructor (private app: AppService, private output: CodexTerminalOutputService, private capabilities?: TabbyCapabilitiesService, private attachments?: AttachmentTransferService, platform?: PlatformService, private config?: ConfigService) {
    const configPath = platform?.getConfigPath()
    if (configPath) this.logs = new TerminalLogStore(path.join(path.dirname(configPath), 'tabby-terminal-logs'))
    if (this.output.chunks$) this.subscriptions.add(this.output.chunks$.subscribe(chunk => {
      if (this.config?.store?.codexAgent?.terminalLogsEnabled === false) {
        for (const capture of this.captures.values()) this.logs?.finish(capture.logId, 'partial', 'Saving disabled')
        this.captures.clear(); return
      }
      for (const capture of this.captures.values()) if (capture.tab === chunk.terminal && capture.stream === chunk.streamId) this.logs?.append(capture.logId, chunk.text)
    }))
    if (this.output.lifecycle$) this.subscriptions.add(this.output.lifecycle$.subscribe(tab => {
      for (const [key, capture] of this.captures) if (capture.tab === tab && (capture.stream !== this.output.streamId(tab) || this.output.isClosed?.(tab))) { this.logs?.finish(capture.logId, 'interrupted', 'Terminal session changed'); this.captures.delete(key) }
    }))
    this.refresh()
    this.subscriptions.add(this.app.tabsChanged$.subscribe(() => this.refresh()))
    this.subscriptions.add(this.app.activeTabChange$.subscribe(() => this.refresh()))
  }

  private allTabs (): BaseTabComponent[] {
    return this.app.tabs.flatMap(tab => tab instanceof SplitTabComponent ? tab.getAllTabs() : [tab])
  }

  private id (tab: BaseTabComponent): string {
    let id = this.ids.get(tab)
    if (!id) { id = `tab-${++this.nextId}`; this.ids.set(tab, id) }
    return id
  }

  private refresh (): void {
    const current = new Set(this.allTabs().filter((tab): tab is BaseTerminalTabComponent<any> => tab instanceof BaseTerminalTabComponent))
    for (const terminal of current) if (!this.tracked.has(terminal)) {
      this.output.watch(terminal)
      this.tracked.add(terminal)
      const watcher = new Subscription()
      let sessionWatcher: Subscription | undefined
      const attach = (session = terminal.session) => {
        sessionWatcher?.unsubscribe()
        this.completedCommands.delete(terminal)
        let pending = ''
        sessionWatcher = new Subscription()
        const ended = () => { this.completedCommands.delete(terminal); sessionWatcher?.unsubscribe() }
        sessionWatcher.add(session?.closed$?.subscribe(ended))
        sessionWatcher.add(session?.destroyed$?.subscribe(ended))
        sessionWatcher.add(session?.output$?.subscribe(chunk => {
          pending = (pending + chunk).slice(-1024)
          if (/\x1b\]133;C(?:;[^\x07\x1b]*)?(?:\x07|\x1b\\)/.test(pending)) {
            this.completedCommands.delete(terminal)
            pending = ''
          }
        }))
      }
      watcher.add(terminal.sessionChanged$?.subscribe(attach))
      watcher.add(() => sessionWatcher?.unsubscribe())
      attach()
      this.completionWatchers.set(terminal, watcher)
    }
    for (const terminal of this.tracked) if (!current.has(terminal)) {
      this.release(terminal)
      this.output.unwatch(terminal)
      this.completionWatchers.get(terminal)?.unsubscribe()
      this.completionWatchers.delete(terminal)
      this.completedCommands.delete(terminal)
      this.tracked.delete(terminal)
    }
    for (const state of this.controlled.values()) if (state.tab.session !== state.session || !state.tab.session?.open) this.release(state.tab)
  }

  private publishControls (): void {
    this.controls$.next(Array.from(this.controlled.values(), ({ tabId, title, owner, command, startedAt }) => ({ tabId, title, owner, command, startedAt })))
  }

  getControl (owner: string): ControlledTab | undefined {
    return this.controls$.value.find(control => control.owner === owner)
  }

  releaseOwner (owner: string): void {
    for (const [key, capture] of this.captures) if (capture.owner === owner) { this.logs?.finish(capture.logId); this.captures.delete(key) }
    this.stopSudoLeases(owner)
    for (const state of Array.from(this.controlled.values())) if (state.owner === owner) this.release(state.tab)
  }

  private stopSudoLeases (owner: string): void {
    const leases = this.sudoLeases.get(owner)
    this.sudoLeases.delete(owner)
    for (const [tab, entry] of leases || []) {
      const state = this.controlled.get(tab)
      const cleanup = () => {
        if (tab.session !== entry.session || !entry.session?.open) return
        if (this.controlled.has(tab)) return
        tab.sendInput(entry.lease.cleanup() + '\r')
      }
      // Never put cleanup text into a foreground process or a different SSH session.
      if (state?.completion === 'prompt') { this.release(tab); cleanup(); continue }
      void this.processes(tab).then(processes => {
        if (!state && processes !== null && !processes.length && !this.controlled.has(tab)) cleanup()
        else {
          let pending = ''
          let completion = state?.completion
          const subscription = entry.session?.output$?.subscribe((chunk: string) => {
            pending = (pending + chunk).slice(-1024)
            const sequence = /\x1b\]133;([ACD])(?:;[^\x07\x1b]*)?(?:\x07|\x1b\\)/g
            let match: RegExpExecArray | null, consumed = 0
            while ((match = sequence.exec(pending))) {
              consumed = sequence.lastIndex
              if (match[1] === 'C') completion = 'running'
              else if (match[1] === 'D' && completion === 'running') completion = 'ended'
              else if (match[1] === 'A' && completion === 'ended') {
                subscription?.unsubscribe()
                cleanup()
                break
              }
            }
            if (consumed) pending = pending.slice(consumed)
          })
          // An unavailable shell prompt cannot safely accept injected cleanup. The lease
          // also stops on terminal exit/authentication failure and has a 12-hour ceiling.
          const timer = setTimeout(() => subscription?.unsubscribe(), 60000)
          ;(timer as any).unref?.()
        }
      }).catch(() => undefined)
    }
  }

  releaseTab (owner: string, tabId: string): boolean {
    const state = Array.from(this.controlled.values()).find(item => item.owner === owner && item.tabId === tabId)
    if (!state) return false
    this.release(state.tab)
    return true
  }

  private release (tab: BaseTerminalTabComponent<any>): void {
    const state = this.controlled.get(tab)
    if (!state) return
    if (state.timer) clearTimeout(state.timer)
    state.subscriptions.unsubscribe()
    tab.sendInput = state.originalSendInput
    this.controlled.delete(tab)
    if (state.completion === 'prompt' && state.automaticCompletion && tab.session === state.session && state.session?.open) {
      this.completedCommands.set(tab, state.session)
      this.completionRevisions.set(tab, (this.completionRevisions.get(tab) || 0) + 1)
    }
    this.publishControls()
  }

  private lock (tab: BaseTerminalTabComponent<any>, owner: string, command: string): ControlState {
    this.release(tab)
    this.completedCommands.delete(tab)
    const state: ControlState = {
      tab, tabId: this.id(tab), title: tab.title, owner, command, startedAt: Date.now(),
      originalSendInput: tab.sendInput, allowInput: false, session: tab.session, emptyChecks: 0, observedProcess: false, automaticCompletion: true, subscriptions: new Subscription(),
    }
    tab.sendInput = (data: string | Buffer) => {
      if (state.allowInput) state.originalSendInput.call(tab, data)
    }
    this.controlled.set(tab, state)
    // Session lifecycle and shell integration provide evidence independent of process enumeration.
    const ended = () => { if (this.controlled.get(tab) === state) this.release(tab) }
    state.subscriptions.add(state.session?.closed$?.subscribe(ended))
    state.subscriptions.add(state.session?.destroyed$?.subscribe(ended))
    state.subscriptions.add(tab.sessionChanged$?.subscribe(session => { if (session !== state.session) ended() }))
    let pending = ''
    state.subscriptions.add(state.session?.output$?.subscribe(chunk => {
      // OSC 133 C -> D -> A: command started, ended, then shell prompt.
      // Require the sequence after ownership began; a bare prompt-like line proves nothing.
      pending = (pending + chunk).slice(-16384)
      const sequence = /\x1b\]133;([ACD])(?:;[^\x07\x1b]*)?(?:\x07|\x1b\\)/g
      let match: RegExpExecArray | null, consumed = 0
      while ((match = sequence.exec(pending))) {
        consumed = sequence.lastIndex
        if (match[1] === 'C') state.completion = 'running'
        else if (match[1] === 'D' && state.completion === 'running') state.completion = 'ended'
        else if (match[1] === 'A' && state.completion === 'ended') {
          state.completion = 'prompt'
          if (state.automaticCompletion && !this.alternateScreen(tab)) { ended(); break }
        }
      }
      if (consumed) pending = pending.slice(consumed)
    }))
    this.publishControls()
    this.pollControl(state)
    return state
  }

  private sendControlled (state: ControlState, data: string): void {
    if (this.controlled.get(state.tab) !== state || state.tab.session !== state.session || !state.session?.open) throw new Error('The terminal session or input owner changed; input was not sent')
    state.allowInput = true
    try { state.tab.sendInput(data) } finally { state.allowInput = false }
  }

  private async verifyInteraction (tab: BaseTerminalTabComponent<any>, owner: string, checkStopped: () => void): Promise<ControlState> {
    const state = this.controlled.get(tab)
    if (!state || state.owner !== owner) throw new Error('Interactive input requires a process owned by this task; launch it or use attach_process first')
    if (state.expectedProcess) {
      if (state.remoteProcess) {
        const identity = await this.remoteProcess(tab, state.expectedProcess, state.remoteProcess)
        checkStopped()
        if (!identity) throw new Error('Remote foreground process identity could not be revalidated; input was not sent. Read the terminal and retry inspection, or release control.')
      } else {
        const processes = await this.processes(tab)
        checkStopped()
        if (processes === null) throw new Error('Process inspection is unavailable; interactive input was not sent. Retry inspection or release the tab.')
        if (!matchesProcess(processes, state.expectedProcess)) {
          this.release(tab)
          throw new Error('The attached agent exited or process inspection failed; interactive input was not sent')
        }
      }
    }
    checkStopped()
    if (!tab.session?.open || tab.session !== state.session || this.controlled.get(tab) !== state) throw new Error('The terminal session or input owner changed; interactive input was not sent')
    return state
  }
  private async verifyObservation (args: any, context?: TabToolContext): Promise<void> {
    if (args.expectedObservation === undefined) return
    if (typeof args.expectedObservation !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedObservation)) throw new Error('Invalid observation fingerprint')
    const current = await this.call('read_tab', { tabId: args.tabId, maxLines: 100, waitMs: 0 }, context)
    if (current.commandState === 'prompt' || observationFingerprint(current) !== args.expectedObservation) throw new Error('交互现场或进程已经变化，未发送旧回答')
  }

  private async serverIdentity (tab: BaseTerminalTabComponent<any>): Promise<WorkflowTarget> {
    const profile = tab.profile as any
    const options = profile?.options || {}
    const local = profile?.type === 'local'
    const host = local ? os.hostname() : typeof options.host === 'string' ? options.host : ''
    let cwd = ''
    try { cwd = await tab.session?.getWorkingDirectory() || '' } catch { /* Unknown paths require live verification. */ }
    const clean = (value: any, limit = 300) => redactMemory(typeof value === 'string' ? value : '', limit)
    return { type: clean(profile?.type, 40), profileId: clean(profile?.id), serverId: clean(profile?.id) || (local ? 'local:' + os.hostname() : ''),
      host: clean(host), ip: local ? '127.0.0.1' : isIP(host) ? host : '',
      port: Number.isInteger(options.port) && options.port > 0 && options.port <= 65535 ? options.port : local ? 0 : profile?.type === 'ssh' ? 22 : 0,
      username: clean(options.user || options.username, 100), cwd: clean(cwd, 1000) }
  }

  private async processes (tab: BaseTerminalTabComponent<any>): Promise<string[] | null> {
    const session = tab.session as any
    // getChildProcesses is a local PTY API, not a BaseSession remote-process contract.
    // Remote/unknown adapters may return a placeholder []; treat that as unavailable.
    if (tab.profile?.type !== 'local' || typeof session?.getChildProcesses !== 'function') return null
    try {
      const children = await session.getChildProcesses()
      if (!Array.isArray(children) || !children.length && this.alternateScreen(tab)) return null
      return children.map(child => String(child.command || `PID ${child.pid}`))
    } catch { return null }
  }

  private async remoteProcess (tab: BaseTerminalTabComponent<any>, expected: string, previous?: RemoteProcessIdentity): Promise<RemoteProcessIdentity | null> {
    const ssh = (tab as any).sshSession, session = tab.session
    if (tab.profile?.type !== 'ssh' || !ssh?.open || !session?.open) return null
    return verifyRemoteProcess({ tabId: this.id(tab), title: tab.title, tab, ssh, session,
      valid: () => this.allTabs().includes(tab) && tab.session === session && (tab as any).sshSession === ssh && !!session.open && !!ssh.open }, expected, previous)
  }

  private alternateScreen (tab: BaseTerminalTabComponent<any>): boolean {
    return !!tab.alternateScreenActive || (tab.frontend as any)?.xterm?.buffer?.active?.type === 'alternate'
  }

  private pollControl (state: ControlState): void {
    state.timer = setTimeout(async () => {
      if (this.controlled.get(state.tab) !== state) return
      if (state.tab.session !== state.session || !state.tab.session?.open) { this.release(state.tab); return }
      if (state.automaticCompletion && state.completion === 'prompt' && !this.alternateScreen(state.tab)) { this.release(state.tab); return }
      try {
        const processes = await this.processes(state.tab)
        if (this.controlled.get(state.tab) !== state) return
        // Child absence proves an attached executable exited. It does not prove a
        // submitted shell command ended: shell builtins such as `read` have no child.
        if (state.automaticCompletion && state.expectedProcess && processes !== null && !this.alternateScreen(state.tab)) {
          if (processes.length) state.observedProcess = true
          state.emptyChecks = processes.length ? 0 : state.observedProcess ? state.emptyChecks + 1 : 0
          if (state.emptyChecks >= 2) { this.release(state.tab); return }
        } else state.emptyChecks = 0
      } catch { /* Keep the lock if process inspection fails. */ }
      if (this.controlled.get(state.tab) === state) this.pollControl(state)
    }, 500)
  }

  private find (tabId: string): BaseTabComponent {
    const tab = this.allTabs().find(item => this.id(item) === tabId)
    if (!tab) throw new Error(`Tab ${tabId} is no longer open; call list_tabs again.`)
    return tab
  }

  attachmentTabId (tab: BaseTerminalTabComponent<any>): string { return this.id(tab) }

  attachmentTarget (tabId: string, owner: string): TransferTarget {
    const tab = this.find(tabId) as BaseTerminalTabComponent<any> & { sshSession?: any }
    if (!(tab instanceof BaseTerminalTabComponent) || tab.profile?.type !== 'ssh' || !tab.session?.open || !tab.sshSession?.open) throw new Error('Select a connected native Tabby SSH terminal for file transfer')
    const ssh = tab.sshSession, session = tab.session
    const options = (tab.profile as any)?.options || {}
    const target: TransferTarget = { tabId, tab, ssh, session, title: `${tab.title} (${options.user || ''}@${options.host || ''}:${options.port || 22})`, valid: () => this.allTabs().includes(tab) && tab.session === session && tab.sshSession === ssh && !!session.open && !!ssh.open }
    target.hideOutput = marker => this.output.hideAttachmentOutput?.(tab, marker)
    // A remote process list is not available. Only a fresh reliable Shell completion
    // permits the PTY fallback; SFTP/exec never require claiming terminal input.
    if (this.completedCommands.get(tab) === session && !this.controlled.has(tab) && !this.alternateScreen(tab)) target.pty = async (script, signal, sink, input) => {
      if (!target.valid() || this.completedCommands.get(tab) !== session || this.controlled.has(tab) || this.alternateScreen(tab)) throw new Error('PTY fallback requires the same verified idle shell')
      const suppress = this.output.suppress?.(tab)
      const state = this.lock(tab, owner, '[attachment transfer]'); state.automaticCompletion = false
      let completed = false
      try { await runAttachmentPty(target, script, signal, text => this.sendControlled(state, text), sink, input); completed = true }
      finally {
        if (completed || state.completion === 'prompt') suppress?.()
        else if (suppress) this.output.holdUntilShellPrompt?.(tab, suppress)
        if (completed) this.release(tab)
      }
    }
    return target
  }

  private capture (tab: BaseTerminalTabComponent<any>, context?: TabToolContext): string | undefined {
    if (!this.logs || !context?.logScope || this.config?.store?.codexAgent?.terminalLogsEnabled === false) return undefined
    const stream = this.output.streamId(tab), key = context.logScope + ':' + stream
    const prior = this.captures.get(key)
    if (prior) return prior.logId
    let logId: string
    try { logId = this.logs.start(context.logScope, stream) } catch { return undefined }
    this.captures.set(key, { owner: context.owner, scope: context.logScope, tab, stream, logId })
    return logId
  }

  private async readStream (tab: BaseTerminalTabComponent<any>, args: any, context?: TabToolContext): Promise<any> {
    const startedAt = Date.now()
    const scope = context?.logScope || context?.owner
    if (!scope) throw new Error('Delta reads require an active session')
    if (args.maxLines !== undefined) throw new Error('maxLines is only valid for snapshot')
    const stream = this.output.streamId(tab), session = tab.session
    const max = Math.max(2, Math.min(20000, Number(args.maxChars) || 8000))
    const baselineRevision = args.cursor ? this.streamTokens.inspect(args.cursor, scope).revision : undefined
    const start = args.cursor ? this.streamTokens.decode(args.cursor, scope, stream) : Math.max(0, this.output.cursor(tab) - max)
    const wait = Math.max(0, Math.min(30000, Number(args.waitMs) || 0))
    const mode = args.waitFor || 'either'
    if (!['output', 'completion', 'either'].includes(mode)) throw new Error('Invalid waitFor')
    let reason = 'immediate'
    if (args.cursor && !this.output.readSince(tab, start, max).text && wait) reason = await this.waitStream(tab, start, wait, mode, context?.signal, baselineRevision)
    if (session !== tab.session || stream !== this.output.streamId(tab)) throw new Error('cursor_session_changed: read the current terminal again')
    const logId = this.capture(tab, context)
    if (this.output.isSuppressed(tab)) return { tabId: args.tabId, text: '[Attachment payload omitted]', wakeReason: reason }
    const slice = this.output.readSince(tab, start, max)
    if (slice.truncated && args.cursor) return { tabId: args.tabId, status: 'cursor_expired', truncated: true, logRef: logId ? { logId } : undefined }
    return { tabId: args.tabId, mode: 'delta', streamId: stream, text: slice.text,
      nextCursor: this.streamTokens.encode(scope, stream, slice.cursor, this.completionRevisions.get(tab) || 0), hasMore: slice.hasMore, truncated: false,
      startPolicy: args.cursor ? undefined : 'tail', wakeReason: reason, waitedMs: Date.now() - startedAt, controlledByAI: this.controlled.has(tab),
      commandState: this.controlled.get(tab)?.completion || (this.completedCommands.get(tab) === session ? 'prompt' : 'unknown'),
      logRef: logId ? { logId, saveState: 'writing' } : undefined }
  }

  private waitStream (tab: BaseTerminalTabComponent<any>, start: number, ms: number, mode: string, signal?: AbortSignal, sinceRevision?: number): Promise<string> {
    const session = tab.session, stream = this.output.streamId(tab)
    const baselineRevision = sinceRevision ?? (this.completionRevisions.get(tab) || 0)
    return new Promise((resolve, reject) => {
      const subscriptions = new Subscription()
      let done = false, settle: ReturnType<typeof setTimeout> | undefined
      let firstOutput = 0
      const deadline = Date.now() + ms
      const finish = (reason: string) => { if (done) return; done = true; clearTimeout(timer); if (settle) clearTimeout(settle); subscriptions.unsubscribe(); signal?.removeEventListener('abort', abort); reason === 'abort' ? reject(new Error('Agent task was stopped')) : resolve(reason) }
      const timer = setTimeout(() => finish('timeout'), ms)
      const abort = () => finish('abort')
      const check = () => {
        if (tab.session !== session || this.output.streamId(tab) !== stream) finish('session_changed')
        else if (!session?.open) finish('session_closed')
        else if (mode !== 'completion' && this.output.cursor(tab) > start && !this.output.isSuppressed(tab)) {
          if (!firstOutput) firstOutput = Date.now()
          if (settle) clearTimeout(settle)
          settle = setTimeout(() => finish('output'), Math.max(0, Math.min(50, 200 - (Date.now() - firstOutput), deadline - Date.now())))
        }
        else if (mode !== 'output' && (this.completionRevisions.get(tab) || 0) > baselineRevision && this.completedCommands.get(tab) === session && !this.controlled.has(tab)) finish('completion')
      }
      signal?.addEventListener('abort', abort, { once: true })
      subscriptions.add(this.output.updates$.subscribe(check))
      subscriptions.add(this.controls$.subscribe(check))
      subscriptions.add(tab.sessionChanged$.subscribe(check))
      subscriptions.add(session?.closed$?.subscribe(() => finish('session_closed')))
      subscriptions.add(session?.destroyed$?.subscribe(() => finish('session_closed')))
      subscriptions.add(this.output.lifecycle$.subscribe(check))
      if (done) subscriptions.unsubscribe()
      if (signal?.aborted) abort(); else check()
    })
  }

  private async waitForTerminal (tab: BaseTabComponent, waitMs: number, signal?: AbortSignal): Promise<void> {
    const terminal = tab instanceof BaseTerminalTabComponent ? tab : undefined
    const session = terminal?.session
    const completed = () => !!terminal && !!session?.open && terminal.session === session && this.completedCommands.get(terminal) === session && !this.controlled.has(terminal)
    await new Promise<void>((resolve, reject) => {
      const subscriptions = new Subscription()
      let settleTimer: ReturnType<typeof setTimeout> | undefined
      const finish = (error?: Error) => {
        clearTimeout(timer)
        if (settleTimer) clearTimeout(settleTimer)
        subscriptions.unsubscribe()
        signal?.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve()
      }
      const abort = () => finish(new Error('Agent task was stopped'))
      const timer = setTimeout(() => finish(), waitMs)
      const checkCompletion = () => {
        // Give xterm's asynchronous write queue a short chance to consume the final output.
        if (completed() && !settleTimer) settleTimer = setTimeout(() => {
          settleTimer = undefined
          if (completed()) finish()
        }, 50)
      }
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) { abort(); return }
      subscriptions.add(this.controls$.subscribe(checkCompletion))
    })
  }

  private controls (tab: BaseTabComponent): Element[] {
    const nodes: Node[] = (tab.hostView as any)?.rootNodes || []
    const selector = 'button,input,textarea,select,a[href],[role="button"]'
    return nodes.flatMap(node => {
      if (typeof (node as Element).querySelectorAll !== 'function') return []
      const root = node as Element
      return [ ...(root.matches?.(selector) ? [root] : []), ...Array.from(root.querySelectorAll(selector)) ]
    })
  }

  private controlId (element: Element): string {
    let id = this.controlIds.get(element)
    if (!id) { id = `control-${++this.nextControlId}`; this.controlIds.set(element, id) }
    return id
  }

  private windowRoot (): Element {
    if (typeof document === 'undefined') throw new Error('Tabby application DOM is unavailable')
    const dialogs = Array.from(document.querySelectorAll('ngb-modal-window,[role="dialog"]')).filter(element => this.visibleControl(element))
    return dialogs[dialogs.length - 1] || document.body
  }

  private visibleControl (element: Element): boolean {
    return !element.closest('[hidden],[aria-hidden="true"],codex-agent-panel,.codex-agent-sidebar') &&
      (!(element as HTMLElement).getClientRects || !!(element as HTMLElement).getClientRects().length)
  }

  private interactControl (element: Element, args: any): void {
    if ((element as HTMLInputElement).disabled || element.getAttribute('aria-disabled') === 'true') throw new Error('Control is disabled')
    if (args.action === 'click') (element as HTMLElement).click()
    else if (args.action === 'set_value') {
      if (typeof args.value !== 'string' || args.value.length > 10000) throw new Error('value must be a string of at most 10,000 characters')
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) throw new Error('Control is not a form field')
      if ((element as HTMLInputElement).readOnly) throw new Error('Control is read-only')
      element.value = args.value
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
    } else throw new Error('Unknown action')
  }

  async call (name: string, args: any, context?: TabToolContext): Promise<any> {
    const checkStopped = () => { if (context?.signal?.aborted) throw new Error('Agent task was stopped; command was not sent') }
    checkStopped()
    if (context?.readOnly && TABBY_MUTATIONS.has(name)) throw new Error('只读模式禁止 Tabby 修改操作')
    this.refresh()
    if (['list_logs', 'read_log', 'search_log'].includes(name)) {
      if (!this.logs || !context?.logScope) throw new Error('Logs unavailable')
      const scope = context.logScope
      if (name === 'list_logs') return this.logs.list(scope)
      const id = args.logId
      if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw new Error('Log unavailable')
      if (name === 'search_log' && (typeof args.query !== 'string' || !args.query.length || args.query.length > 256)) throw new Error('query must contain 1..256 characters')
      const cursorKey = scope + ':' + id + ':' + (name === 'search_log' ? args.query : '')
      const token = args.cursor ? this.streamTokens.inspect(args.cursor, cursorKey) : undefined
      const offset = token?.offset || 0
      const high = token && token.stream !== 'follow' ? Number(token.stream) : undefined
      if (high !== undefined && (!Number.isSafeInteger(high) || high < offset)) throw new Error('Cursor unavailable')
      const limit = name === 'search_log' ? 65536 : Math.max(2, Math.min(20000, Number(args.maxChars) || 8000))
      const result = await this.logs.read(scope, id, offset, limit, high, context.signal)
      checkStopped()
      if (name === 'search_log') {
        const hits = []; let responseChars = 0; let index = result.text.indexOf(args.query)
        while (index >= 0 && hits.length < 50 && responseChars < 8000) {
          const at = offset + Math.max(0, index - 80)
          responseChars += args.query.length + 160
          hits.push({ text: result.text.slice(Math.max(0, index - 80), index + args.query.length + 80), cursor: this.streamTokens.encode(scope + ':' + id + ':', String(result.readEnd), at) })
          index = result.text.indexOf(args.query, index + 1)
        }
        const partial = result.hasMore || index >= 0
        const next = index >= 0 ? offset + index : result.hasMore ? result.offset - Math.min(args.query.length - 1, result.text.length - 1) : result.offset
        return { hits, partial, nextCursor: partial ? this.streamTokens.encode(cursorKey, String(result.readEnd), next) : undefined, logState: result.logState, reason: result.reason, scannedRange: [offset, result.offset] }
      }
      return { ...result, followCursor: this.streamTokens.encode(cursorKey, 'follow', result.readEnd), nextCursor: result.hasMore ? this.streamTokens.encode(cursorKey, String(result.readEnd), result.offset) : undefined }
    }
    if (name.startsWith('attachment_')) {
      if (!this.attachments || !context?.owner) throw new Error('Attachments require an active session')
      const owner = context.owner
      if (name === 'attachment_list') return this.attachments.list(owner)
      if (name === 'attachment_status') return this.attachments.wait(owner, args.operationId, Math.max(0, Math.min(10000, Number(args.waitMs) || 0)))
      if (name === 'attachment_cancel') return this.attachments.cancel(owner, args.operationId)
      if (name === 'attachment_upload' || name === 'attachment_download') {
        const target = this.attachmentTarget(args.tabId, owner)
        const operation = this.attachments.start(owner, target, name === 'attachment_upload' ? 'upload' : 'download', args)
        return this.attachments.wait(owner, operation.operationId)
      }
      throw new Error('Unknown attachment operation')
    }
    if (name === 'list_tabs') return this.allTabs().map(tab => ({
      id: this.id(tab), title: tab.title, type: tab instanceof BaseTerminalTabComponent ? 'terminal' : 'other',
      active: tab === this.app.activeTab || (tab.topmostParent === this.app.activeTab && this.app.activeTab instanceof SplitTabComponent && this.app.activeTab.getFocusedTab() === tab),
      terminalOpen: tab instanceof BaseTerminalTabComponent ? !!tab.session?.open : undefined,
      profileType: tab instanceof BaseTerminalTabComponent ? tab.profile?.type : undefined,
      sshTarget: tab instanceof BaseTerminalTabComponent && tab.profile?.type === 'ssh' ? `${(tab.profile as any)?.options?.user || ''}@${(tab.profile as any)?.options?.host || ''}:${(tab.profile as any)?.options?.port || 22}` : undefined,
      controlledByAI: tab instanceof BaseTerminalTabComponent ? this.controlled.has(tab) : undefined,
    }))
    if (name === 'read_window') {
      const root = this.windowRoot()
      this.windowControls.clear()
      const elements = Array.from(root.querySelectorAll('button,input,textarea,select,a[href],[role="button"],[role="tab"],[role="checkbox"]')).filter(element => this.visibleControl(element)).slice(0, 150)
      const controls = elements.map(element => {
        const id = this.controlId(element)
        this.windowControls.set(id, { element, root })
        const field = element as HTMLInputElement
        return { id, tag: element.tagName.toLowerCase(), label: element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('placeholder') || (element.textContent || '').trim().slice(0, 150),
          value: field.type === 'password' ? undefined : field.value, checked: field.type === 'checkbox' ? field.checked : undefined, disabled: !!field.disabled }
      })
      const text = (root as HTMLElement).innerText || ''
      return { dialog: root !== document.body, text: text.slice(0, 20000), truncated: text.length > 20000, controls }
    }
    if (name === 'interact_window') {
      const entry = this.windowControls.get(args?.controlId)
      if (!entry || !entry.element.isConnected || entry.root !== this.windowRoot() || !this.visibleControl(entry.element)) throw new Error('Application control is stale; call read_window again')
      this.interactControl(entry.element, args)
      return { done: true, next: 'Call read_window or read_tab to verify the resulting state.' }
    }
    if (TABBY_OPERATIONS.some(tool => tool.name === name) && !['close_tab', 'duplicate_tab', 'rename_tab', 'split_tab', 'layout_tabs'].includes(name)) {
      if (!this.capabilities) throw new Error('Tabby capability service is unavailable')
      return this.capabilities.call(name, args || {}, args?.tabId ? this.find(args.tabId) : undefined, checkStopped)
    }
    if (!args || typeof args.tabId !== 'string') throw new Error('tabId is required')
    if (name === 'read_tab') {
      const current = this.find(args.tabId)
      const waitMs = Math.max(0, Math.min(30000, Number(args.waitMs ?? (current instanceof BaseTerminalTabComponent && this.controlled.has(current) ? 1000 : 0)) || 0))
      if (!['snapshot', 'delta', undefined].includes(args.mode)) throw new Error('Invalid read mode')
      if (current instanceof BaseTerminalTabComponent) {
        this.capture(current, context)
        if (args.mode === 'delta') return this.readStream(current, { ...args, waitMs }, context)
        if (args.cursor || args.maxChars !== undefined) throw new Error('cursor/maxChars require delta mode')
        if (args.waitFor) {
          if (!['output', 'completion', 'either'].includes(args.waitFor)) throw new Error('Invalid waitFor')
          if (waitMs) await this.waitStream(current, this.output.cursor(current), waitMs, args.waitFor, context?.signal)
        } else if (waitMs) await this.waitForTerminal(current, waitMs, context?.signal)
      } else {
        if (args.mode === 'delta' || args.cursor || args.waitFor) throw new Error('Terminal parameters require a terminal')
        if (waitMs) await this.waitForTerminal(current, waitMs, context?.signal)
      }
      checkStopped()
    }
    const tab = this.find(args.tabId)
    if (name === 'close_tab') {
      if (this.app.tabs.includes(tab)) await this.app.closeTab(tab, true)
      else {
        // AppService.closeTab only accepts top-level tabs; leaf panes must use
        // their own close check and destruction lifecycle.
        if (!await tab.canClose()) return { closed: false, tabId: args.tabId }
        checkStopped()
        tab.destroy()
      }
      return { closed: !this.allTabs().includes(tab), tabId: args.tabId }
    }
    if (name === 'duplicate_tab') {
      const opened = await this.app.duplicateTab(tab)
      return { opened: !!opened, tabId: opened ? this.id(opened) : undefined }
    }
    if (name === 'rename_tab') {
      if (typeof args.title !== 'string' || args.title.length > 200) throw new Error('title must be a string of at most 200 characters')
      tab.customTitle = args.title
      tab.setTitle(args.title)
      this.app.emitTabsChanged()
      return { tabId: args.tabId, title: tab.title }
    }
    if (name === 'split_tab' || name === 'layout_tabs') {
      let parent = tab.topmostParent
      if (!(parent instanceof SplitTabComponent) && name === 'split_tab') {
        if (!['r', 'l', 't', 'b'].includes(args.direction)) throw new Error('Invalid split direction')
        this.app.removeTab(tab)
        parent = this.app.wrapAndAddTab(tab)
      }
      if (!(parent instanceof SplitTabComponent)) throw new Error('This pane is not inside a split container')
      if (name === 'split_tab') {
        if (!['r', 'l', 't', 'b'].includes(args.direction)) throw new Error('Invalid split direction')
        const opened = await parent.splitTab(tab, args.direction)
        return { opened: !!opened, tabId: opened ? this.id(opened) : undefined }
      }
      if (args.action === 'equalize') parent.equalize()
      else if (args.action === 'maximize') parent.maximize(tab)
      else if (args.action === 'restore') parent.maximize(null)
      else if (args.action === 'explode') this.app.explodeTab(parent)
      else throw new Error('Unknown layout action')
      return { done: true, next: 'Call list_tabs to inspect the layout.' }
    }
    if (name === 'release_tab') {
      if (!context?.owner) throw new Error('No active Codex session owns this tab')
      return { released: this.releaseTab(context.owner, args.tabId), tabId: args.tabId }
    }
    if (name === 'select_tab') {
      const top = tab.topmostParent || tab
      this.app.selectTab(top)
      if (top instanceof SplitTabComponent) top.focus(tab)
      return { selected: args.tabId, title: tab.title }
    }
    if (name === 'read_tab') {
      const maxLines = Math.max(1, Math.min(300, Number(args.maxLines) || 100))
      if (tab instanceof BaseTerminalTabComponent) {
        if (this.output.isSuppressed?.(tab)) return { tabId: args.tabId, text: '[Attachment transfer in progress; payload omitted. Use attachment_status.]', commandState: 'running', controlledByAI: true }
        const observedSession = tab.session, observedStream = this.output.streamId?.(tab)
        const scope = context?.logScope || context?.owner
        const nextCursor = scope && observedStream ? this.streamTokens.encode(scope, observedStream, this.output.cursor(tab), this.completionRevisions.get(tab) || 0) : undefined
        const server = await this.serverIdentity(tab)
        const runningProcesses = await this.processes(tab)
        if (observedSession !== tab.session) throw new Error('Terminal session changed during observation')
        checkStopped()
        const commandState = this.controlled.get(tab)?.completion || (this.completedCommands.get(tab) === tab.session ? 'prompt' : 'unknown')
        const xterm = (tab.frontend as any)?.xterm
        const buffer = xterm?.buffer?.active
        if (buffer && typeof buffer.getLine === 'function') {
          const start = Math.max(0, buffer.length - maxLines)
          const lines: string[] = []
          for (let i = start; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) || '')
          const text = lines.join('\n'), safeText = this.output.sanitizeView?.(tab, text) ?? text
          return { tabId: args.tabId, title: tab.title, server, commandState, text: safeText.slice(-20000), truncated: start > 0 || text.length > 20000, nextCursor, cursorRelation: 'before_snapshot', runningProcesses, controlledByAI: this.controlled.has(tab), interaction: safeText === text ? terminalInteractionState(xterm, start) : undefined }
        }
        const end = this.output.cursor(tab)
        const slice = this.output.readSince(tab, Math.max(0, end - 20000), 20000)
        return { tabId: args.tabId, title: tab.title, server, commandState, text: slice.text, truncated: slice.truncated, nextCursor, cursorRelation: 'before_snapshot', runningProcesses, controlledByAI: this.controlled.has(tab), note: '终端界面尚未就绪，仅有插件启动后的输出。' }
      }
      const nodes: Node[] = (tab.hostView as any)?.rootNodes || []
      const text = nodes.map(node => node.textContent || '').join('\n').trim()
      const controls = this.controls(tab).slice(0, 100).map(element => {
        const field = element as HTMLInputElement
        return {
          id: this.controlId(element), tag: element.tagName.toLowerCase(),
          label: element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('placeholder') || (element.textContent || '').trim().slice(0, 100),
          value: field.type === 'password' ? undefined : field.value,
          checked: field.type === 'checkbox' ? field.checked : undefined,
        }
      })
      return { tabId: args.tabId, title: tab.title, text: text.slice(0, 20000), truncated: text.length > 20000, controls }
    }
    if (name === 'send_input') {
      if (!(tab instanceof BaseTerminalTabComponent)) throw new Error('This tab is not a terminal')
      if (!tab.session?.open) throw new Error('The terminal session is closed')
      this.capture(tab, context)
      if (typeof args.text !== 'string' || args.text.length > TERMINAL_INPUT_MAX_LENGTH) throw new Error('text must be a string of at most 10,000 characters')
      const owner = context?.owner || 'legacy'
      const existing = this.controlled.get(tab)
      if (existing && existing.owner !== owner) throw new Error(`Tab ${args.tabId} is controlled by another Codex session`)
      if (args.mode === 'stdin') {
        await this.verifyObservation(args, context)
        const state = await this.verifyInteraction(tab, owner, checkStopped)
        checkStopped()
        this.sendControlled(state, args.text + (args.submit ? '\r' : ''))
        return { sent: true, tabId: args.tabId, submitted: !!args.submit, mode: 'stdin' }
      }
      if (args.mode && args.mode !== 'command') throw new Error('Unknown input mode')
      if (existing) return { sent: false, blocked: true, reason: 'A command already owns this tab. Use stdin mode to interact with it, or wait for it to finish before starting another command.' }
      const session = tab.session
      const running = await this.processes(tab)
      checkStopped()
      if (running?.length || running === null) {
        if (args.foregroundTaskNeeded === true) return { sent: false, blocked: true, reason: 'Existing foreground task is needed; wait for it or interact using stdin mode if this session owns it.', runningProcesses: running }
        if (running?.length && args.foregroundTaskNeeded !== false) return { sent: false, blocked: true, reason: 'Inspect the existing process and decide whether the current task needs it before sending a new command.', runningProcesses: running }
        // The task authorizes takeover. Unknown enumeration (common over SSH)
        // is not a reason to ask the user, nor evidence that Ctrl+C is needed.
        if (running?.length) {
          if (tab.session !== session || this.controlled.has(tab)) throw new Error('The terminal changed before takeover')
          tab.sendInput('\x03')
          let remaining: string[] | null = running
          for (let attempt = 0; attempt < 6; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 300))
            checkStopped()
            if (tab.session !== session || !session.open || this.controlled.has(tab)) throw new Error('The terminal changed during takeover')
            remaining = await this.processes(tab)
            checkStopped()
            if (remaining === null || !remaining.length) break
          }
          if (remaining === null || remaining.length) throw new Error('The previous process could not be confirmed stopped after Ctrl+C; command was not sent')
        }
      }
      checkStopped()
      if (this.controlled.has(tab)) throw new Error('The terminal was taken by another command during takeover')
      if (tab.session !== session) throw new Error('The terminal session changed before the command was sent')
      if (!tab.session?.open) throw new Error('The terminal session closed before the command was sent')
      const server = await this.serverIdentity(tab)
      checkStopped()
      if (tab.session !== session || this.controlled.has(tab)) throw new Error('Terminal changed while reading its identity')
      const state = this.lock(tab, owner, args.text.slice(0, 120))
      // A prompt between pasted lines does not prove the entire batch finished.
      // Multiline submissions require explicit release after inspecting their results.
      state.automaticCompletion = !/[\r\n]/.test(args.text)
      let commandText = args.text
      if (context?.sudoLease && args.submit) {
        let leases = this.sudoLeases.get(owner)
        if (!leases) { leases = new Map(); this.sudoLeases.set(owner, leases) }
        let entry = leases.get(tab)
        if (!entry || entry.session !== tab.session) { entry = { lease: new SudoWorkflowLease(), session: tab.session }; leases.set(tab, entry) }
        commandText = entry.lease.wrap(commandText)
        state.automaticCompletion = false
      }
      try { this.sendControlled(state, commandText + (args.submit ? '\r' : '')) } catch (error) { this.release(tab); throw error }
      if (!args.submit) this.release(tab)
      return { sent: true, tabId: args.tabId, server, submitted: !!args.submit, userInputLocked: !!args.submit }
    }
    if (name === 'attach_process') {
      if (!(tab instanceof BaseTerminalTabComponent) || !tab.session?.open) throw new Error('An open terminal is required')
      if (!context?.owner || typeof args.purpose !== 'string' || !args.purpose.trim() || typeof args.expectedProcess !== 'string') throw new Error('An active task, expectedProcess and purpose are required')
      if (this.controlled.has(tab)) throw new Error('This terminal is already controlled; inspect its owner before attaching')
      const session = tab.session
      const processes = await this.processes(tab)
      checkStopped()
      const remote = processes === null ? await this.remoteProcess(tab, args.expectedProcess) : null
      checkStopped()
      if (processes === null && !remote) throw new Error('Cannot verify the existing agent process in this terminal: independent SSH exec, Linux /proc and an exact foreground PTY identity are required. Input was not sent; the agent was preserved. Inspect the connection capabilities; do not restart it merely because it is waiting for input.')
      if (processes !== null && !matchesProcess(processes, args.expectedProcess)) throw new Error('The expected agent process is not running; inspect the terminal again')
      if (tab.session !== session || !session.open || this.controlled.has(tab)) throw new Error('The terminal changed while inspecting the process')
      const state = this.lock(tab, context.owner, `交互：${args.expectedProcess}`)
      state.expectedProcess = args.expectedProcess
      state.remoteProcess = remote || undefined
      state.observedProcess = true
      return { attached: true, tabId: args.tabId, expectedProcess: args.expectedProcess, userInputLocked: true, note: 'Existing process preserved; use send_keys or send_input(mode=stdin), then read_tab to verify.' }
    }
    if (name === 'send_keys') {
      if (!(tab instanceof BaseTerminalTabComponent)) throw new Error('This tab is not a terminal')
      await this.verifyObservation(args, context)
      const state = await this.verifyInteraction(tab, context?.owner || 'legacy', checkStopped)
      checkStopped()
      const sequence = terminalKeySequence(args, !!(tab.frontend as any)?.xterm?.modes?.applicationCursorKeysMode)
      this.sendControlled(state, sequence)
      return { sent: true, tabId: args.tabId, key: args.key, shift: !!args.shift, alt: !!args.alt, ctrl: !!args.ctrl, repeat: args.repeat ?? 1, note: 'Read the terminal to verify the effect before the next action.' }
    }
    if (name === 'interact_tab') {
      if (tab instanceof BaseTerminalTabComponent) throw new Error('Use send_input for terminal tabs')
      const element = this.controls(tab).find(item => this.controlId(item) === args.controlId)
      if (!element) throw new Error('Control is no longer available; call read_tab again')
      this.interactControl(element, args)
      return { tabId: args.tabId, controlId: args.controlId, action: args.action, done: true }
    }
    throw new Error(`Unknown Tabby tool: ${name}`)
  }

  ngOnDestroy (): void {
    for (const watcher of this.completionWatchers.values()) watcher.unsubscribe()
    this.completionWatchers.clear()
    for (const owner of Array.from(this.sudoLeases.keys())) this.stopSudoLeases(owner)
    for (const capture of this.captures.values()) this.logs?.finish(capture.logId, 'interrupted')
    this.captures.clear()
    this.subscriptions.unsubscribe()
    for (const tab of Array.from(this.controlled.keys())) this.release(tab)
    for (const terminal of this.tracked) this.output.unwatch(terminal)
    this.tracked.clear()
  }
}
