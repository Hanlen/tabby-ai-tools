import type { AgentClient } from './agent-types'

/** Shared by rendering and context export, including paginated Codex threads. */
export async function readThreadHistory (client: AgentClient, threadId: string): Promise<{ thread: any; turns: any[]; notice: string }> {
  const metadata = await client.request('thread/read', { threadId, includeTurns: false })
  let turns: any[] = [], notice = ''
  try {
    if (metadata.thread?.historyMode === 'paginated') {
      let cursor: string | null = null
      const seenCursors = new Set<string>()
      do {
        const page: { data: any[]; nextCursor: string | null } = await client.request('thread/turns/list', {
          threadId, cursor, limit: 100, sortDirection: 'desc', itemsView: 'full',
        })
        turns.unshift(...(page.data || []).slice().reverse())
        cursor = page.nextCursor || null
        if (cursor) {
          if (seenCursors.has(cursor)) throw new Error('历史分页返回了重复游标')
          seenCursors.add(cursor)
        }
      } while (cursor)
    } else {
      const result = await client.request('thread/read', { threadId, includeTurns: true })
      turns = result.thread?.turns || []
    }
  } catch (error: any) {
    const message = String(error?.message || error)
    if (message.includes('not materialized yet') && message.includes('before first user message')) turns = []
    else if (message.includes('list_turns is not supported yet') || message.includes('thread/turns/list is not supported yet')) {
      notice = 'Codex 当前无法读取旧消息；会话已连接，新消息仍可正常使用。'
    } else throw error
  }
  return { thread: metadata.thread || {}, turns, notice }
}
