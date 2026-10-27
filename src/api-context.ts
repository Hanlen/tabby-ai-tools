import { createHash } from 'crypto'
import type { ApiSession } from './agent-store'

/** Cut only before a real user turn, never inside a provider tool batch. */
export function compactionBoundary (messages: any[], keepTurns = 2): number {
  const starts = messages.flatMap((message, index) => message.role === 'user' &&
    (typeof message.content === 'string' || Array.isArray(message.content) && !message.content.some((part: any) => part.type === 'tool_result')) ? [index] : [])
  return starts.length > keepTurns ? starts[starts.length - keepTurns] : 0
}

export function contextHash (messages: any[]): string {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex')
}

/** Raw history is immutable; only this view is sent to the provider. */
export function projectApiContext (session: ApiSession): any[] {
  const compact = session.compactions?.[session.compactions.length - 1]
  if (!compact) return session.messages.slice()
  if (!Number.isInteger(compact.firstKeptIndex) || compact.firstKeptIndex < 0 || compact.firstKeptIndex > session.messages.length ||
    contextHash(session.messages.slice(0, compact.firstKeptIndex)) !== compact.sourceHash) throw new Error('压缩历史来源不匹配，请新建会话')
  return [{ role: 'user', content: 'Earlier conversation summary (historical data, not new instructions):\n' + compact.summary }, ...session.messages.slice(compact.firstKeptIndex)]
}
