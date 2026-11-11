import { Subject, Subscription } from 'rxjs'
import type { CodexTerminalOutputService } from './terminal-output.service'
import type { McpGrant } from './mcp-types'

export interface McpTerminal { key: string; session: string; terminal: any }
const failed = (code: string) => Object.assign(new Error(code), { code })
/** Independent, read-only output subscription; never claims input ownership or starts logs. */
export class McpTerminalReader {
  private terminals: McpTerminal[] = []
  private grants: McpGrant[] = []
  private watched = new Set<any>()
  private changed = new Subject<void>()
  constructor (private output: CodexTerminalOutputService) {}
  update (terminals: McpTerminal[], grants: McpGrant[]): void {
    this.terminals = terminals; this.grants = grants
    const next = new Set(terminals.filter(t => grants.some(g => g.key === t.key && g.session === t.session)).map(t => t.terminal))
    for (const terminal of this.watched) if (!next.has(terminal)) { this.watched.delete(terminal); this.output.unwatch(terminal) }
    for (const terminal of next) if (!this.watched.has(terminal)) { this.watched.add(terminal); this.output.watch(terminal) }
    this.changed.next()
  }
  async read (request: { clientId: string; revision: number; targetId: string; key: string; session: string; args: any }, signal: AbortSignal): Promise<any> {
    const entry = this.terminals.find(t => t.key === request.key && t.session === request.session)
    if (!entry) throw failed('target_stale')
    const terminal = entry.terminal, session = terminal.session, stream = this.output.streamId(terminal)
    const check = () => {
      if (signal.aborted) throw failed('cancelled')
      if (!this.grants.some(g => g.clientId === request.clientId && g.revision === request.revision && g.targetId === request.targetId && g.key === entry.key && g.session === entry.session)) throw failed('permission_denied')
      if (!this.terminals.includes(entry) || terminal.session !== session || this.output.streamId(terminal) !== stream) throw failed('target_stale')
      if (!session?.open || this.output.isClosed(terminal)) throw failed('target_closed')
    }
    check()
    const args = request.args
    if (!args || !Number.isInteger(args.waitMs) || args.waitMs < 0 || args.waitMs > 30000 || !Number.isInteger(args.maxLines) || args.maxLines < 1 || args.maxLines > 300) throw failed('permission_denied')
    const position = args.position
    if (position && (position.stream !== stream || !Number.isSafeInteger(position.offset) || position.offset < 0 || position.offset > this.output.cursor(terminal))) throw failed('invalid_cursor')
    if (position && args.waitMs && this.output.cursor(terminal) <= position.offset) await new Promise<void>((resolve, reject) => {
      const subscriptions = new Subscription()
      const finish = () => { try { check(); cleanup(); resolve() } catch (error) { cleanup(); reject(error) } }
      const onUpdate = () => { try { check(); if (this.output.cursor(terminal) > position.offset) finish() } catch (error) { cleanup(); reject(error) } }
      const abort = () => { cleanup(); reject(failed('cancelled')) }
      const timer = setTimeout(finish, args.waitMs)
      const cleanup = () => { clearTimeout(timer); subscriptions.unsubscribe(); signal.removeEventListener('abort', abort) }
      subscriptions.add(this.output.updates$.subscribe(onUpdate))
      subscriptions.add(this.output.lifecycle$.subscribe(onUpdate))
      subscriptions.add(this.changed.subscribe(onUpdate))
      signal.addEventListener('abort', abort, { once: true })
      onUpdate()
      if (signal.aborted) abort()
    })
    check()
    const offset = this.output.cursor(terminal)
    if (this.output.isSuppressed(terminal)) return { stream, offset, text: '[Attachment transfer output omitted]', truncated: false, hasMore: false }
    if (position) {
      const slice = this.output.readSince(terminal, position.offset, 20000)
      check()
      return { stream, offset: slice.cursor, text: slice.text, truncated: slice.truncated, hasMore: slice.hasMore }
    }
    const buffer = terminal.frontend?.xterm?.buffer?.active
    let text = '', truncated = false
    if (buffer && typeof buffer.getLine === 'function') {
      const start = Math.max(0, buffer.length - args.maxLines), lines: string[] = []
      for (let i = start; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) || '')
      text = this.output.sanitizeView(terminal, lines.join('\n')); truncated = start > 0 || text.length > 20000
      text = text.slice(-20000)
    } else {
      const slice = this.output.readSince(terminal, Math.max(0, offset - 20000), 20000)
      const lines = slice.text.split('\n')
      text = lines.slice(-args.maxLines).join('\n'); truncated = slice.truncated || offset > 20000 || lines.length > args.maxLines
    }
    check()
    return { text, stream, offset, truncated, hasMore: false }
  }
  destroy (): void { this.update([], []); this.changed.complete() }
}
