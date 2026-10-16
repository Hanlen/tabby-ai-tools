import { Injectable, OnDestroy } from '@angular/core'
import { AppService, BaseTabComponent, SplitTabComponent } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { BehaviorSubject, Subscription } from 'rxjs'
import { CodexTerminalOutputService } from './terminal-output.service'

export interface ControlledTab { tabId: string; title: string; owner: string; command: string; startedAt: number }
export interface TakeoverRequest { tabId: string; title: string; processes: string[]; purpose: string; unknown: boolean; verifyIdle?: boolean }
export interface TabToolContext {
  owner: string
  confirmTakeover?: (request: TakeoverRequest) => Promise<'interrupt' | 'proceed' | 'cancel'>
}

interface ControlState extends ControlledTab {
  tab: BaseTerminalTabComponent<any>
  originalSendInput: BaseTerminalTabComponent<any>['sendInput']
  allowInput: boolean
  session: BaseTerminalTabComponent<any>['session']
  emptyChecks: number
  timer?: ReturnType<typeof setTimeout>
}

export const TAB_TOOLS = [{
  type: 'namespace',
  name: 'tabby_tabs',
  description: 'Inspect and operate tabs in the current Tabby window. List tabs first to obtain their current IDs.',
  tools: [
    { type: 'function', name: 'list_tabs', description: 'List every open Tabby tab, including terminal panes inside split tabs.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { type: 'function', name: 'read_tab', description: 'Read the visible terminal screen and scrollback, or text from another Tabby tab. Does not execute anything.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, maxLines: { type: 'integer', minimum: 1, maximum: 300 } }, required: ['tabId'], additionalProperties: false } },
    { type: 'function', name: 'select_tab', description: 'Switch the Tabby window to a tab or split terminal pane.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, required: ['tabId'], additionalProperties: false } },
    { type: 'function', name: 'send_input', description: 'Send input to a terminal. Before a new command, inspect the tab and any running process. If an existing process is needed for the task, set foregroundTaskNeeded=true and do not replace it. If unrelated, set false and explain purpose; the user must approve interruption. Set mode=stdin only to interact with a process already owned by this turn. A submitted command locks user input until it exits or the user releases the tab.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' }, mode: { type: 'string', enum: ['command', 'stdin'] }, purpose: { type: 'string' }, foregroundTaskNeeded: { type: 'boolean' } }, required: ['tabId', 'text'], additionalProperties: false } },
    { type: 'function', name: 'release_tab', description: 'Release a terminal tab after your command is finished so the user can type in it again.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, required: ['tabId'], additionalProperties: false } },
    { type: 'function', name: 'interact_tab', description: 'Click or fill a control in a non-terminal Tabby tab. Use read_tab to discover control IDs first.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, controlId: { type: 'string' }, action: { type: 'string', enum: ['click', 'set_value'] }, value: { type: 'string' } }, required: ['tabId', 'controlId', 'action'], additionalProperties: false } },
  ],
}]

@Injectable()
export class TabbyTabToolsService implements OnDestroy {
  readonly controls$ = new BehaviorSubject<ControlledTab[]>([])
  private controlled = new Map<BaseTerminalTabComponent<any>, ControlState>()
  private ids = new WeakMap<BaseTabComponent, string>()
  private nextId = 0
  private controlIds = new WeakMap<Element, string>()
  private nextControlId = 0
  private tracked = new Set<BaseTerminalTabComponent<any>>()
  private subscriptions = new Subscription()

  constructor (private app: AppService, private output: CodexTerminalOutputService) {
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
    tab.sendInput = state.originalSendInput
    this.controlled.delete(tab)
    this.publishControls()
  }

  private lock (tab: BaseTerminalTabComponent<any>, owner: string, command: string): ControlState {
    this.release(tab)
    const state: ControlState = {
      tab, tabId: this.id(tab), title: tab.title, owner, command, startedAt: Date.now(),
      originalSendInput: tab.sendInput, allowInput: false, session: tab.session, emptyChecks: 0,
    }
    tab.sendInput = (data: string | Buffer) => {
      if (state.allowInput) state.originalSendInput.call(tab, data)
    }
    this.controlled.set(tab, state)
    this.publishControls()
    this.pollControl(state)
    return state
  }

  private sendControlled (state: ControlState, data: string): void {
    state.allowInput = true
    try { state.tab.sendInput(data) } finally { state.allowInput = false }
  }

  private async processes (tab: BaseTerminalTabComponent<any>): Promise<string[] | null> {
    const session = tab.session as any
    if (typeof session?.getChildProcesses !== 'function') return null
    try {
      const children = await session.getChildProcesses()
      return Array.isArray(children) ? children.map(child => String(child.command || `PID ${child.pid}`)) : null
    } catch { return null }
  }

  private pollControl (state: ControlState): void {
    state.timer = setTimeout(async () => {
      if (this.controlled.get(state.tab) !== state) return
      if (state.tab.session !== state.session || !state.tab.session?.open) { this.release(state.tab); return }
      try {
        const processes = await this.processes(state.tab)
        if (this.controlled.get(state.tab) !== state) return
        if (processes !== null) {
          state.emptyChecks = processes.length ? 0 : state.emptyChecks + 1
          if (state.emptyChecks >= 2) { this.release(state.tab); return }
        }
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

  async call (name: string, args: any, context?: TabToolContext): Promise<any> {
    this.refresh()
    if (name === 'list_tabs') return this.allTabs().map(tab => ({
      id: this.id(tab), title: tab.title, type: tab instanceof BaseTerminalTabComponent ? 'terminal' : 'other',
      active: tab === this.app.activeTab || (tab.topmostParent === this.app.activeTab && this.app.activeTab instanceof SplitTabComponent && this.app.activeTab.getFocusedTab() === tab),
      terminalOpen: tab instanceof BaseTerminalTabComponent ? !!tab.session?.open : undefined,
      controlledByAI: tab instanceof BaseTerminalTabComponent ? this.controlled.has(tab) : undefined,
    }))
    if (!args || typeof args.tabId !== 'string') throw new Error('tabId is required')
    const tab = this.find(args.tabId)
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
          return { tabId: args.tabId, title: tab.title, text: text.slice(-20000), truncated: start > 0 || text.length > 20000, runningProcesses: await this.processes(tab), controlledByAI: this.controlled.has(tab) }
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
        if (!existing) throw new Error('stdin mode requires a command already controlled by this Codex session')
        this.sendControlled(existing, args.text + (args.submit ? '\r' : ''))
        return { sent: true, tabId: args.tabId, submitted: !!args.submit, mode: 'stdin' }
      }
      if (args.mode && args.mode !== 'command') throw new Error('Unknown input mode')
      if (existing) return { sent: false, blocked: true, reason: 'A command already owns this tab. Use stdin mode to interact with it, or wait for it to finish before starting another command.' }
      const session = tab.session
      const running = await this.processes(tab)
      if (running?.length || running === null) {
        if (args.foregroundTaskNeeded === true) return { sent: false, blocked: true, reason: 'Existing foreground task is needed; wait for it or interact using stdin mode if this session owns it.', runningProcesses: running }
        if (running?.length && args.foregroundTaskNeeded !== false) return { sent: false, blocked: true, reason: 'Inspect the existing process and decide whether the current task needs it before sending a new command.', runningProcesses: running }
        if (!context?.confirmTakeover) throw new Error('User confirmation is required before taking over this terminal')
        const choice = await context.confirmTakeover({ tabId: args.tabId, title: tab.title, processes: running || [], purpose: String(args.purpose || args.text).slice(0, 300), unknown: running === null })
        if (choice === 'cancel') return { sent: false, cancelled: true, tabId: args.tabId }
        if (tab.session !== session || this.controlled.has(tab)) throw new Error('The terminal changed while awaiting confirmation; command was not sent')
        const current = await this.processes(tab)
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
      if (this.controlled.has(tab)) throw new Error('The terminal was taken by another command while awaiting confirmation')
      if (tab.session !== session) throw new Error('The terminal session changed before the command was sent')
      if (!tab.session?.open) throw new Error('The terminal session closed before the command was sent')
      const state = this.lock(tab, owner, args.text.slice(0, 120))
      try { this.sendControlled(state, args.text + (args.submit ? '\r' : '')) } catch (error) { this.release(tab); throw error }
      if (!args.submit) this.release(tab)
      return { sent: true, tabId: args.tabId, submitted: !!args.submit, userInputLocked: !!args.submit }
    }
    if (name === 'interact_tab') {
      if (tab instanceof BaseTerminalTabComponent) throw new Error('Use send_input for terminal tabs')
      const element = this.controls(tab).find(item => this.controlId(item) === args.controlId)
      if (!element) throw new Error('Control is no longer available; call read_tab again')
      if (args.action === 'click') {
        (element as HTMLElement).click()
      } else if (args.action === 'set_value') {
        if (typeof args.value !== 'string') throw new Error('value must be a string')
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) throw new Error('Control is not a form field')
        element.value = args.value
        element.dispatchEvent(new Event('input', { bubbles: true }))
        element.dispatchEvent(new Event('change', { bubbles: true }))
      } else throw new Error('Unknown action')
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
