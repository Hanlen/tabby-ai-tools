import { promises as fs } from 'fs'
import * as path from 'path'
import { randomBytes, createHash } from 'crypto'
import { AgentContext, ApiProfile } from './agent-types'
import type { ToolLoopState } from './api-loop-guard'

export function agentId (): string { return 'api-' + randomBytes(16).toString('hex') }
export function profileFingerprint (p: ApiProfile): string {
  return createHash('sha256').update(JSON.stringify([p.id, p.provider, p.baseUrl.replace(/\/+$/, ''), p.model])).digest('hex')
}
export interface ApiTurn {
  id: string
  status: 'inProgress' | 'completed' | 'interrupted' | 'failed'
  items: any[]
}
export interface ApiSession {
  version: 1
  id: string
  cwd: string
  profileId: string
  fingerprint: string
  model: string
  updatedAt: number
  messages: any[]
  turns: ApiTurn[]
  totalTokens: number
  claudeSession?: { id: string; messageCount: number }
  toolLoopState?: ToolLoopState
  goal?: { objective: string; status: string; tokenBudget: number; usedTokens: number }
}

export class AgentStore {
  private writes = Promise.resolve()
  constructor (private root: string) {}
  private file (id: string): string {
    if (!/^api-[a-f0-9]{32}$/.test(id)) throw new Error('无效的 API 会话 ID')
    return path.join(this.root, id + '.json')
  }
  async load (id: string): Promise<ApiSession> {
    if ((await fs.stat(this.file(id))).size > 32 * 1024 * 1024) throw new Error('API 会话文件过大，请新建会话')
    const data = JSON.parse(await fs.readFile(this.file(id), 'utf8'))
    if (data.version !== 1 || data.id !== id || typeof data.cwd !== 'string' || typeof data.profileId !== 'string' || typeof data.model !== 'string' || typeof data.fingerprint !== 'string' ||
      !Number.isFinite(data.updatedAt) || !Number.isFinite(data.totalTokens) || data.totalTokens < 0 || !Array.isArray(data.messages) || !Array.isArray(data.turns) ||
      data.messages.some((message: any) => !message || typeof message !== 'object') ||
      data.turns.some((turn: any) => !turn || typeof turn.id !== 'string' || !['inProgress', 'completed', 'failed', 'interrupted'].includes(turn.status) || !Array.isArray(turn.items)) ||
      (data.goal && (typeof data.goal.objective !== 'string' || typeof data.goal.status !== 'string' || !Number.isFinite(data.goal.tokenBudget) || !Number.isFinite(data.goal.usedTokens)))) {
      throw new Error('API 会话文件损坏或版本不兼容')
    }
    return data
  }
  async list (): Promise<ApiSession[]> {
    let files: string[]
    try { files = await fs.readdir(this.root) } catch (error: any) { if (error.code === 'ENOENT') return []; throw error }
    return Promise.all(files.filter(file => /^api-[a-f0-9]{32}\.json$/.test(file)).map(file => this.load(file.slice(0, -5))))
  }
  async loadCodexContext (threadId: string): Promise<AgentContext | undefined> {
    return (await this.loadCodexContextRecord(threadId))?.context
  }
  async loadCodexContextRecord (threadId: string): Promise<{ context: AgentContext; goalPending: boolean } | undefined> {
    const file = this.contextFile(threadId)
    try {
      if ((await fs.stat(file)).size > 32 * 1024 * 1024) throw new Error('会话上下文文件过大')
      const data = JSON.parse(await fs.readFile(file, 'utf8'))
      if (data.version !== 1 || data.threadId !== threadId || !data.context || typeof data.context.cwd !== 'string' ||
        !Array.isArray(data.context.messages) || !Array.isArray(data.context.turns)) throw new Error('Codex 迁移上下文文件损坏')
      return { context: data.context, goalPending: !!data.goalPending }
    } catch (error: any) { if (error.code === 'ENOENT') return undefined; throw error }
  }
  saveCodexContext (threadId: string, context: AgentContext, goalPending = false): Promise<void> {
    return this.write(this.contextFile(threadId), JSON.stringify({ version: 1, threadId, context, goalPending }))
  }
  private contextFile (threadId: string): string {
    return path.join(this.root, 'codex-contexts', createHash('sha256').update(threadId).digest('hex') + '.json')
  }
  save (session: ApiSession): Promise<void> {
    return this.write(this.file(session.id), JSON.stringify(session))
  }
  private write (file: string, data: string): Promise<void> {
    if (Buffer.byteLength(data) > 32 * 1024 * 1024) return Promise.reject(new Error('API 会话文件过大，请新建会话'))
    const write = this.writes.then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      const temporary = file + '.' + randomBytes(6).toString('hex') + '.tmp'
      try {
        await fs.writeFile(temporary, data, { mode: 0o600, flag: 'wx' })
        await fs.rename(temporary, file)
      } finally { await fs.unlink(temporary).catch(() => undefined) }
    })
    this.writes = write.catch(() => undefined)
    return write
  }
}
