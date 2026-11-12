import type { McpGrant, McpLease } from './mcp-types'
import type { McpTerminal } from './mcp-terminals'
import type { TabbyTabToolsService } from './tab-tools'
const failure = (code: string) => Object.assign(new Error(code), { code })
/** Renderer boundary around the shared sidebar/scheduler input controller. */
export class McpTerminalExecution {
  private terminals: McpTerminal[] = []
  private grants: McpGrant[] = []
  private leases: McpLease[] = []
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private tools?: TabbyTabToolsService
  constructor (private getTools: () => TabbyTabToolsService) {}
  update (terminals: McpTerminal[], grants: McpGrant[], leases: McpLease[]): void {
    const next = leases.filter(l => l.expiresAt > Date.now() && grants.some(g => g.clientId === l.clientId && g.revision === l.revision && g.targetId === l.targetId && g.mode && g.mode !== 'read_only') && terminals.some(t => t.key === l.key && t.session === l.session))
    for (const old of this.leases) if (!next.some(l => l.id === old.id)) this.release(old.id)
    for (const lease of next) {
      clearTimeout(this.timers.get(lease.id))
      const timer = setTimeout(() => this.release(lease.id), Math.max(0, lease.expiresAt - Date.now()))
      ;(timer as any).unref?.()
      this.timers.set(lease.id, timer)
    }
    this.terminals = terminals; this.grants = grants; this.leases = next
  }
  release (id: string): void {
    clearTimeout(this.timers.get(id)); this.timers.delete(id)
    this.leases = this.leases.filter(l => l.id !== id)
    this.tools?.releaseOwner('mcp:' + id)
  }
  async execute (request: any, signal: AbortSignal): Promise<any> {
    const entry = this.terminals.find(t => t.key === request.key && t.session === request.session), session = entry?.terminal.session
    const check = () => {
      if (signal.aborted) throw failure('cancelled')
      if (!entry || !this.terminals.includes(entry) || entry.terminal.session !== session || !session?.open) throw failure('target_stale')
      if (!this.grants.some(g => g.clientId === request.clientId && g.revision === request.revision && g.targetId === request.targetId && g.key === entry.key && g.session === entry.session && g.mode && g.mode !== 'read_only')) throw failure('permission_denied')
      if (!this.leases.some(l => l.id === request.leaseId && l.clientId === request.clientId && l.revision === request.revision && l.targetId === request.targetId && l.key === entry.key && l.session === entry.session && l.expiresAt > Date.now())) throw failure('invalid_lease')
    }
    check()
    if (!['send_input', 'send_keys', 'attach_process', 'release_tab'].includes(request.tool)) throw failure('permission_denied')
    const args = request.args
    if (!args || (request.tool === 'send_input' && (typeof args.text !== 'string' || args.text.length > 10000 || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(args.text)))) throw failure('permission_denied')
    this.tools ||= this.getTools()
    let inputAttempted = false
    const context = { onInput: () => { inputAttempted = true }, owner: 'mcp:' + request.leaseId, signal, beforeInput: check, allowTakeover: false }
    try {
      // Whitelist again: no sudo, owner, takeover, workflow or internal tab IDs.
      const values = request.tool === 'send_input' ? { text: args.text, submit: args.submit, mode: args.mode } : request.tool === 'send_keys' ? { key: args.key, shift: args.shift, alt: args.alt, ctrl: args.ctrl, repeat: args.repeat } : request.tool === 'attach_process' ? { expectedProcess: args.expectedProcess, purpose: args.purpose } : {}
      const result = await this.tools.callTerminal(request.tool, values, entry!.terminal, context)
      check()
      if (result.blocked) return { sent: false, blocked: true, reason: 'Terminal busy or idle state cannot be verified; no interruption was sent.' }
      const safe: any = {}
      for (const key of ['sent', 'submitted', 'mode', 'attached', 'released', 'key', 'shift', 'alt', 'ctrl', 'repeat', 'userInputLocked']) if (result[key] !== undefined) safe[key] = result[key]
      return { ...safe, note: 'Verify the terminal output. Sending input is not evidence of task completion; release does not stop the process.' }
    } catch (error: any) {
      this.tools.releaseOwner(context.owner)
      if (inputAttempted) throw failure('unknown_outcome')
      if (error.code) throw error
      throw failure(signal.aborted ? 'unknown_outcome' : 'busy')
    }
  }
  destroy (): void { this.update([], [], []) }
}
