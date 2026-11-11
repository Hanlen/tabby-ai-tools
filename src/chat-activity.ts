/** Display records are separate from the provider's native model context. */
export interface ChatEntry {
  navigationTurnIds?: string[]
  turnId?: string
  outcome?: import('./agent-conversation-state').ConversationOutcome
  id: string
  kind: 'user' | 'agent' | 'tool' | 'system' | 'thinking'
  text: string
  title?: string
  running?: boolean
  expanded?: boolean
}

export const THINKING_DISPLAY_LIMIT = 32000

export function thinkingText (text: string): string {
  return text.length > THINKING_DISPLAY_LIMIT ? text.slice(0, THINKING_DISPLAY_LIMIT) + '\n…' : text
}

export function activityEntry (item: any, running = false): ChatEntry | undefined {
  if (!item?.id) return undefined
  if (item.type === 'reasoning') {
    // Only display text the backend explicitly returned. Never render encrypted content.
    const text = [...(item.summary || []), ...(item.content || [])]
      .map(part => typeof part === 'string' ? part : part.text || '').filter(Boolean).join('\n\n')
    if (!text.trim()) return undefined
    return { id: item.id, kind: 'thinking', text: thinkingText(text), running }
  }
  if (item.type === 'commandExecution') return { id: item.id, kind: 'tool', title: item.command || '',
    text: `$ ${item.command || ''}\n${item.aggregatedOutput || ''}`, running }
  if (['dynamicToolCall', 'mcpToolCall'].includes(item.type)) return { id: item.id, kind: 'tool', title: item.tool || '',
    text: `${item.tool || ''} ${JSON.stringify(item.arguments ?? {})}\n${JSON.stringify(item.result ?? item.contentItems ?? item.error ?? '')}`, running }
  return undefined
}
