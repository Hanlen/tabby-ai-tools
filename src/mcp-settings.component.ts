import { ChangeDetectorRef, Component, OnDestroy } from '@angular/core'
import { PlatformService } from 'tabby-core'
import { Subscription } from 'rxjs'
import { McpService } from './mcp.service'
import { McpState, emptyMcpState } from './mcp-types'
import { mcpClientConfig, McpClientKind } from './mcp-client-config'
import { translate } from './i18n'

@Component({ selector: 'tabby-mcp-settings', template: require('./mcp-settings.pug'), styles: [require('./mcp-settings.css')] })
export class McpSettingsComponent implements OnDestroy {
  readonly t = translate
  state: McpState = emptyMcpState()
  name = ''
  selectedId = ''
  kind: McpClientKind = 'codex'
  token = ''
  busy = false
  notice = ''
  port = 0
  private destroyed = false
  private subscription: Subscription
  get selected () { return this.state.clients.find(c => c.id === this.selectedId) }
  get configuration (): string { return this.token && this.state.endpoint ? mcpClientConfig(this.kind, this.state.endpoint, this.token) : '' }
  private acceptState (state: McpState): void {
    if (this.destroyed) return
    this.state = state; this.port = state.port
    if (!state.clients.some(c => c.id === this.selectedId)) this.select(state.clients[0]?.id || '')
    if (!state.running) this.token = ''
    this.change.markForCheck()
  }
  constructor (private mcp: McpService, private platform: PlatformService, private change: ChangeDetectorRef) {
    this.subscription = mcp.changes$.subscribe(state => this.acceptState(state))
    void this.mcp.start()
  }
  select (id: string): void { this.selectedId = id; this.token = ''; this.notice = '' }
  private async request (type: string, values: any = {}): Promise<any> {
    const result = await this.mcp.action(type, values)
    if (result && typeof result.enabled === 'boolean' && Array.isArray(result.clients)) this.acceptState(result)
    return result
  }
  private async run (action: () => Promise<void>): Promise<void> {
    if (this.busy) return
    this.busy = true; this.notice = ''
    try { await action() } catch (error: any) {
      const message = String(error.message || error)
      // A rejected IPC response does not prove whether the write took effect.
      try { if (!this.destroyed) await this.request('state') } catch { /* Preserve the operation failure; never repeat the mutation. */ }
      if (!this.destroyed) this.notice = message
    }
    finally { this.busy = false; if (!this.destroyed) this.change.markForCheck() }
  }
  async toggle (enabled: boolean, input?: HTMLInputElement): Promise<void> {
    this.token = ''
    await this.run(async () => { await this.request('enabled', { enabled }) })
    if (input) input.checked = this.state.enabled
  }
  refresh (): Promise<void> { return this.run(async () => { await this.request('state') }) }
  setPort (): Promise<void> { return this.run(async () => { await this.request('port', { port: Number(this.port) }) }) }
  add (): Promise<void> { return this.run(async () => {
    const credential = await this.request('add', { name: this.name })
    if (this.destroyed) return
    await this.request('state')
    if (this.destroyed || !this.state.clients.some(c => c.id === credential.id)) return
    this.selectedId = credential.id; this.name = ''
    if (!this.destroyed) this.token = credential.token
  }) }
  rotate (): Promise<void> { return this.run(async () => {
    const id = this.selectedId
    this.token = ''
    const credential = await this.request('rotate', { id })
    if (this.destroyed) return
    await this.request('state')
    if (this.destroyed || this.selectedId !== id || credential.id !== id || !this.selected) return
    this.token = credential.token
    this.notice = '旧凭据已失效，请更新客户端配置。'
  }) }
  revoke (): Promise<void> { return this.run(async () => { this.token = ''; await this.request('revoke', { id: this.selectedId }) }) }
  async scope (target: string, granted: boolean, input?: HTMLInputElement): Promise<void> { await this.run(async () => {
    const targets = new Set(this.selected?.targets || [])
    if (granted) targets.add(target); else targets.delete(target)
    await this.request('scope', { id: this.selectedId, targets: [...targets] })
  }); if (input) input.checked = this.selected?.targets.includes(target) || false }
  installAgentSkill (): Promise<void> { return this.run(async () => { await this.request('install-agent-skill') }) }
  setMode (mode: string, input?: HTMLSelectElement): Promise<void> { return this.run(async () => { await this.request('mode', { id: this.selectedId, mode }) }).finally(() => { if (input) input.value = this.selected?.mode || 'read_only' }) }
  decide (id: string, accept: boolean): Promise<void> { return this.run(async () => { await this.request('decide', { id, accept }) }) }
  releaseLease (id: string): Promise<void> { return this.run(async () => { await this.request('release-lease', { id }) }) }
  copy (): Promise<void> { return this.run(async () => { await this.platform.setClipboard({ text: this.configuration }); this.notice = '配置已复制，请在客户端中手动合并并重新连接。' }) }
  ngOnDestroy (): void { this.destroyed = true; this.token = ''; this.subscription.unsubscribe() }
}
