import { Injectable, OnDestroy } from '@angular/core'
import { AppService, BaseTabComponent, SplitTabComponent } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { BehaviorSubject, Subscription } from 'rxjs'
import { CodexTerminalOutputService } from './terminal-output.service'
import { TabbyCapabilitiesService } from './tabby-capabilities.service'
import { TABBY_MUTATIONS, TABBY_OPERATIONS } from './tabby-operations'
import { matchesProcess, terminalKeySequence, terminalInteractionState } from './terminal-keys'

export interface ControlledTab { tabId: string; title: string; owner: string; command: string; startedAt: number }
export interface TakeoverRequest { tabId: string; title: string; processes: string[]; purpose: string; unknown: boolean; verifyIdle?: boolean }
export interface TabToolContext {
  owner: string
  signal?: AbortSignal
  readOnly?: boolean
  confirmTakeover?: (request: TakeoverRequest) => Promise<'interrupt' | 'proceed' | 'cancel'>
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
  timer?: ReturnType<typeof setTimeout>
}

export { TAB_TOOLS } from './tab-tool-definitions'

@Injectable()
export class TabbyTabToolsService implements OnDestroy {
  readonly controls$ = new BehaviorSubject<ControlledTab[]>([])
  private controlled = new Map<BaseTerminalTabComponent<any>, ControlState>()
  private ids = new WeakMap<BaseTabComponent, string>()
  private nextId = 0
  private controlIds = new WeakMap<Element, string>()
  private nextControlId = 0
  private windowControls = new Map<string, { element: Element; root: Element }>()
  private tracked = new Set<BaseTerminalTabComponent<any>>()
  private subscriptions = new Subscription()

  constructor (private app: AppService, private output: CodexTerminalOutputService, private capabilities?: TabbyCapabilitiesService) {
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
    }
    for (const terminal of this.tracked) if (!current.has(terminal)) {
      this.release(terminal)
      this.output.unwatch(terminal)
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
    for (const state of Array.from(this.controlled.values())) if (state.owner === owner) this.release(state.tab)
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
    this.publishControls()
  }

  private lock (tab: BaseTerminalTabComponent<any>, owner: string, command: string): ControlState {
    this.release(tab)
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
      const processes = await this.processes(tab)
      checkStopped()
      if (processes === null) throw new Error('Process inspection is unavailable; interactive input was not sent. Retry inspection or release the tab.')
      if (!matchesProcess(processes, state.expectedProcess)) {
        this.release(tab)
        throw new Error('The attached agent exited or process inspection failed; interactive input was not sent')
      }
    }
    checkStopped()
    if (!tab.session?.open || tab.session !== state.session || this.controlled.get(tab) !== state) throw new Error('The terminal session or input owner changed; interactive input was not sent')
    return state
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
    if (name === 'list_tabs') return this.allTabs().map(tab => ({
      id: this.id(tab), title: tab.title, type: tab instanceof BaseTerminalTabComponent ? 'terminal' : 'other',
      active: tab === this.app.activeTab || (tab.topmostParent === this.app.activeTab && this.app.activeTab instanceof SplitTabComponent && this.app.activeTab.getFocusedTab() === tab),
      terminalOpen: tab instanceof BaseTerminalTabComponent ? !!tab.session?.open : undefined,
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
      if (waitMs) await new Promise<void>((resolve, reject) => {
        const signal = context?.signal
        const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new Error('Agent task was stopped')) }
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, waitMs)
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      })
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
        const xterm = (tab.frontend as any)?.xterm
        const buffer = xterm?.buffer?.active
        if (buffer && typeof buffer.getLine === 'function') {
          const start = Math.max(0, buffer.length - maxLines)
          const lines: string[] = []
          for (let i = start; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) || '')
          const text = lines.join('\n')
          return { tabId: args.tabId, title: tab.title, text: text.slice(-20000), truncated: start > 0 || text.length > 20000, runningProcesses: await this.processes(tab), controlledByAI: this.controlled.has(tab), interaction: terminalInteractionState(xterm, start) }
        }
        const end = this.output.cursor(tab)
        const slice = this.output.readSince(tab, Math.max(0, end - 20000), 20000)
        return { tabId: args.tabId, title: tab.title, text: slice.text, truncated: slice.truncated, runningProcesses: await this.processes(tab), controlledByAI: this.controlled.has(tab), note: '终端界面尚未就绪，仅有插件启动后的输出。' }
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
      if (typeof args.text !== 'string' || args.text.length > 10000) throw new Error('text must be a string of at most 10,000 characters')
      const owner = context?.owner || 'legacy'
      const existing = this.controlled.get(tab)
      if (existing && existing.owner !== owner) throw new Error(`Tab ${args.tabId} is controlled by another Codex session`)
      if (args.mode === 'stdin') {
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
        if (!context?.confirmTakeover) throw new Error('User confirmation is required before taking over this terminal')
        const choice = await context.confirmTakeover({ tabId: args.tabId, title: tab.title, processes: running || [], purpose: String(args.purpose || args.text).slice(0, 300), unknown: running === null })
        if (choice === 'cancel') return { sent: false, cancelled: true, tabId: args.tabId }
        if (tab.session !== session || this.controlled.has(tab)) throw new Error('The terminal changed while awaiting confirmation; command was not sent')
        const current = await this.processes(tab)
        checkStopped()
        if (running !== null && current === null) throw new Error('Process status became unavailable; inspect the tab again')
        if (running !== null && current !== null && current.length && JSON.stringify(current) !== JSON.stringify(running)) throw new Error('The running process changed while awaiting confirmation; inspect the tab again')
        if (choice === 'interrupt') {
          if (current === null || current.length) tab.sendInput('\x03')
          if (current === null) {
            const verified = await context.confirmTakeover({ tabId: args.tabId, title: tab.title, processes: [], purpose: String(args.purpose || args.text).slice(0, 300), unknown: true, verifyIdle: true })
            if (verified !== 'proceed') return { sent: false, cancelled: true, interrupted: true, tabId: args.tabId }
            if (tab.session !== session || this.controlled.has(tab)) throw new Error('The terminal changed while awaiting confirmation; command was not sent')
          }
          if (current !== null && current.length) {
            let remaining: string[] | null = current
            for (let attempt = 0; attempt < 6; attempt++) {
              await new Promise(resolve => setTimeout(resolve, 300))
              remaining = await this.processes(tab)
              if (!remaining?.length) break
            }
            if (remaining === null || remaining.length) throw new Error('The previous process could not be confirmed stopped after Ctrl+C; command was not sent')
          }
        } else if (choice !== 'proceed' || current !== null && current.length) throw new Error('The terminal is still occupied; command was not sent')
      }
      checkStopped()
      if (this.controlled.has(tab)) throw new Error('The terminal was taken by another command while awaiting confirmation')
      if (tab.session !== session) throw new Error('The terminal session changed before the command was sent')
      if (!tab.session?.open) throw new Error('The terminal session closed before the command was sent')
      const state = this.lock(tab, owner, args.text.slice(0, 120))
      // A prompt between pasted lines does not prove the entire batch finished.
      // Multiline submissions require explicit release after inspecting their results.
      state.automaticCompletion = !/[\r\n]/.test(args.text)
      try { this.sendControlled(state, args.text + (args.submit ? '\r' : '')) } catch (error) { this.release(tab); throw error }
      if (!args.submit) this.release(tab)
      return { sent: true, tabId: args.tabId, submitted: !!args.submit, userInputLocked: !!args.submit }
    }
    if (name === 'attach_process') {
      if (!(tab instanceof BaseTerminalTabComponent) || !tab.session?.open) throw new Error('An open terminal is required')
      if (!context?.owner || typeof args.purpose !== 'string' || !args.purpose.trim() || typeof args.expectedProcess !== 'string') throw new Error('An active task, expectedProcess and purpose are required')
      if (this.controlled.has(tab)) throw new Error('This terminal is already controlled; inspect its owner before attaching')
      const session = tab.session
      const processes = await this.processes(tab)
      checkStopped()
      if (processes === null) throw new Error('Cannot verify the existing agent process in this terminal; ask the user to launch it under this task or verify the connection')
      if (!matchesProcess(processes, args.expectedProcess)) throw new Error('The expected agent process is not running; inspect the terminal again')
      if (tab.session !== session || !session.open || this.controlled.has(tab)) throw new Error('The terminal changed while inspecting the process')
      const state = this.lock(tab, context.owner, `交互：${args.expectedProcess}`)
      state.expectedProcess = args.expectedProcess
      state.observedProcess = true
      return { attached: true, tabId: args.tabId, expectedProcess: args.expectedProcess, userInputLocked: true, note: 'Existing process preserved; use send_keys or send_input(mode=stdin), then read_tab to verify.' }
    }
    if (name === 'send_keys') {
      if (!(tab instanceof BaseTerminalTabComponent)) throw new Error('This tab is not a terminal')
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
    this.subscriptions.unsubscribe()
    for (const tab of Array.from(this.controlled.keys())) this.release(tab)
    for (const terminal of this.tracked) this.output.unwatch(terminal)
    this.tracked.clear()
  }
}
