import type { ApiSession, AgentStore } from './agent-store'
import type { ModelToolCall, ToolResult } from './api-provider'

/** A durable result cache, not permission to replay a shell operation under a new ID. */
export async function journaledToolCall (session: ApiSession, store: AgentStore, call: ModelToolCall, execute: () => Promise<ToolResult>): Promise<ToolResult> {
  const signature = JSON.stringify([call.name, call.arguments])
  const actions = session.actions ||= {}
  const previous = actions[call.id]
  if (previous) {
    if (previous.signature !== signature) throw new Error('Pi 动作 ID 冲突')
    return previous.result || { id: call.id, result: '该动作结果未知。先读取终端核对实际状态，禁止自动重放。', error: true }
  }
  actions[call.id] = { signature, status: 'pending' }
  await store.save(session)
  const result = await execute()
  actions[call.id] = { signature, status: 'completed', result }
  await store.save(session)
  return result
}
