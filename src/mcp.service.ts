import { Injectable, Injector, NgZone, OnDestroy } from '@angular/core'
import { AppService, SplitTabComponent } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { BehaviorSubject, Subscription } from 'rxjs'
import { randomBytes } from 'crypto'
import * as path from 'path'
import { CodexTerminalOutputService } from './terminal-output.service'
import { MCP_CHANNEL, emptyMcpState, McpState, McpGrant } from './mcp-types'
import { McpTerminalReader, McpTerminal } from './mcp-terminals'
import { McpTerminalExecution } from './mcp-execution'
import { TabbyTabToolsService } from './tab-tools'
import { McpLease } from './mcp-types'

@Injectable()
export class McpService implements OnDestroy {
  readonly changes$ = new BehaviorSubject<McpState>(emptyMcpState())
  private ipc: any
  private subscriptions = new Subscription()
  private entries = new Map<any, McpTerminal & { actualSession: any; closed: boolean; watchers: Subscription; sessionWatchers: Subscription }>()
  private grants: McpGrant[] = []
  private reads = new Map<string, AbortController>()
  private leases: McpLease[] = []
  private execution: McpTerminalExecution
  private reader: McpTerminalReader
  private ready: Promise<void> | undefined
  private destroyed = false
  private publishing = false
  private publishAgain = false
  private listener = (_event: any, message: any) => {
    if (this.destroyed) return
    if (message.type === 'state') {
      this.grants = message.grants || []; this.leases = message.leases || []; this.updateReader()
      this.zone.run(() => this.changes$.next(message.state))
    } else if (message.type === 'release') this.execution.release(message.leaseId)
    else if (message.type === 'cancel') this.reads.get(message.id)?.abort()
    else if (message.type === 'read' || message.type === 'execute') {
      const controller = new AbortController()
      this.reads.set(message.id, controller)
      void (message.type === 'execute' ? this.execution.execute(message, controller.signal) : this.reader.read(message, controller.signal)).then(value => this.reply({ id: message.id, value }), (error: any) => this.reply({ id: message.id, error: error.code || 'internal_error' })).finally(() => this.reads.delete(message.id))
    }
  }
  constructor (private app: AppService, output: CodexTerminalOutputService, private zone: NgZone, injector: Injector) { this.reader = new McpTerminalReader(output); this.execution = new McpTerminalExecution(() => injector.get(TabbyTabToolsService)) }
  get state (): McpState { return this.changes$.value }
  private reply (message: any): void {
    if (this.destroyed) return
    try { this.ipc.send(MCP_CHANNEL + '-reply', message) } catch {
      // The main observation has a deadline. Never replay a failed reply.
      this.zone.run(() => this.changes$.next({ ...this.state, error: 'MCP reply channel is unavailable. Refresh settings or restart Tabby.' }))
    }
  }
  start (): Promise<void> {
    return this.ready ||= this.initialize().catch((error: any) => {
      if (!this.destroyed) this.zone.run(() => this.changes$.next({ ...this.state, error: String(error.message || error) }))
    })
  }
  private async initialize (): Promise<void> {
    if (!process.versions.electron) throw new Error('MCP requires the Tabby desktop host')
    const remote = require('@electron/remote')
    const entry = path.join(__dirname, '..', 'dist', 'mcp', 'electron-host.cjs')
    const mainProcess = remote.getGlobal('process')
    if (typeof mainProcess.getBuiltinModule === 'function') mainProcess.getBuiltinModule('node:module').createRequire(entry)(entry).install()
    else if (typeof remote.require === 'function') remote.require(entry).install()
    else throw new Error('This Tabby host does not support the MCP main bridge')
    if (this.destroyed) return
    this.ipc = require('electron').ipcRenderer
    this.ipc.on(MCP_CHANNEL, this.listener)
    await this.ipc.invoke(MCP_CHANNEL, { type: 'register' })
    if (this.destroyed) return
    this.subscriptions.add(this.app.tabsChanged$.subscribe(() => this.refresh()))
    this.refresh()
  }
  private updateReader (): void {
    const terminals = [...this.entries.values()].filter(e => !e.closed && e.terminal.session)
    this.reader.update(terminals, this.grants); this.execution.update(terminals, this.grants, this.leases)
  }
  private refresh (): void {
    if (this.destroyed) return
    const tabs = this.app.tabs.flatMap(tab => tab instanceof SplitTabComponent ? tab.getAllTabs() : [tab]).filter((tab): tab is BaseTerminalTabComponent<any> => tab instanceof BaseTerminalTabComponent)
    for (const [tab, entry] of this.entries) if (!tabs.includes(tab)) { entry.watchers.unsubscribe(); entry.sessionWatchers.unsubscribe(); this.entries.delete(tab) }
    for (const tab of tabs) {
      if (this.entries.has(tab)) continue
      const entry = { key: randomBytes(16).toString('hex'), session: '', terminal: tab, actualSession: undefined as any, closed: true, watchers: new Subscription(), sessionWatchers: new Subscription() }
      this.entries.set(tab, entry)
      const attach = () => {
        if (entry.actualSession === tab.session) return
        entry.sessionWatchers.unsubscribe(); entry.sessionWatchers = new Subscription()
        entry.actualSession = tab.session; entry.session = randomBytes(16).toString('hex'); entry.closed = !tab.session
        const closed = () => { entry.closed = true; this.updateReader(); this.publish() }
        entry.sessionWatchers.add(tab.session?.closed$?.subscribe(closed))
        entry.sessionWatchers.add(tab.session?.destroyed$?.subscribe(closed))
        this.updateReader(); this.publish()
      }
      entry.watchers.add((tab as BaseTerminalTabComponent<any>).sessionChanged$.subscribe(attach))
      attach()
    }
    this.updateReader(); this.publish()
  }
  private publish (): void {
    this.publishAgain = true
    if (this.publishing || !this.ipc || this.destroyed) return
    this.publishing = true
    void (async () => {
      while (this.publishAgain && !this.destroyed) {
        this.publishAgain = false
        const targets = [...this.entries.values()].filter(e => !e.closed && e.terminal.session).map(e => {
          const profile = e.terminal.profile, options = profile?.options || {}
          const type = typeof profile?.type === 'string' ? profile.type.slice(0, 30) : 'terminal'
          const host = typeof options.host === 'string' ? options.host.slice(0, 100) : ''
          const user = typeof (options.user || options.username) === 'string' ? (options.user || options.username).slice(0, 60) : ''
          const label = [type, host ? (user ? user + '@' : '') + host : ''].filter(Boolean).join(' ')
          return { key: e.key, session: e.session, title: (String(e.terminal.customTitle || e.terminal.title || 'Terminal') + ' [' + label + ']').slice(0, 200) }
        })
        await this.ipc.invoke(MCP_CHANNEL, { type: 'targets', targets })
      }
    })().catch((error: any) => {
      if (!this.destroyed) this.zone.run(() => this.changes$.next({ ...this.state, error: error.message }))
    }).finally(() => {
      this.publishing = false
      // A refresh can arrive after the loop drained but before this finally.
      if (this.publishAgain && !this.destroyed) this.publish()
    })
  }
  async action (type: string, values: any = {}): Promise<any> {
    await this.start()
    if (!this.ipc || this.destroyed) throw new Error(this.state.error || 'MCP is unavailable')
    if (type === 'state') this.refresh()
    return this.ipc.invoke(MCP_CHANNEL, { ...values, type })
  }
  ngOnDestroy (): void {
    this.destroyed = true
    this.subscriptions.unsubscribe()
    for (const item of this.entries.values()) { item.watchers.unsubscribe(); item.sessionWatchers.unsubscribe() }
    for (const controller of this.reads.values()) controller.abort()
    this.reads.clear(); this.entries.clear()
    this.reader.destroy(); this.execution.destroy()
    if (this.ipc) {
      try {
        this.ipc.removeListener(MCP_CHANNEL, this.listener)
        void this.ipc.invoke(MCP_CHANNEL, { type: 'unregister' }).catch(() => undefined)
      } catch { /* The renderer context may already be gone. */ }
    }
    this.changes$.complete()
  }
}
