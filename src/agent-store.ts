import { promises as fs } from 'fs'
import * as path from 'path'
import { randomBytes, createHash } from 'crypto'
import { AgentContext, ApiProfile, usesResponsesApi } from './agent-types'
import { piModel, piProvider, piCatalog } from './pi-config'
import type { ToolLoopState } from './api-loop-guard'
import { InstructionsSnapshot, validateInstructionsSnapshot } from './agent-instructions'

export function agentId (): string { return 'api-' + randomBytes(16).toString('hex') }
export function profileFingerprint (p: ApiProfile): string {
  if (p.piConnection) return createHash('sha256').update(JSON.stringify([p.id, 'pi-v1', p.piConnection.mode,
    p.piConnection.mode === 'native' ? p.piConnection.providerId : '', (p.baseUrl || piModel(p)?.baseUrl || piProvider(p)?.baseUrl || '').replace(/\/+$/, ''), p.model, piModel(p)?.api || p.piConnection.api || 'catalog', piCatalog.sdkVersion])).digest('hex')
  // Keep existing provider fingerprints stable; custom protocols have incompatible native history.
  const identity = [p.id, p.provider, p.baseUrl.replace(/\/+$/, ''), p.model]
  if (p.provider === 'custom') identity.push(usesResponsesApi(p) ? 'responses' : 'chat-completions')
  if (p.runtime === 'pi') identity.push('pi')
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}
export interface ApiTurn {
  id: string
  status: 'inProgress' | 'completed' | 'interrupted' | 'failed'
  items: any[]
}
export interface ApiSession {
  spaceKey?: string
  instructions?: InstructionsSnapshot
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
  lastInputTokens?: number
  claudeSession?: { id: string; messageCount: number }
  piSession?: { file: string; messageCount: number }
  compactions?: { summary: string; firstKeptIndex: number; sourceHash: string; createdAt: number; tokens: number }[]
  actions?: Record<string, { signature: string; status: 'pending' | 'completed'; result?: { id: string; result: string; error?: boolean } }>
  toolLoopState?: ToolLoopState
  goal?: { objective: string; status: string; tokenBudget: number; usedTokens: number }
}

export class AgentStore {
  private writes = Promise.resolve()
  constructor (private root: string) {}
  get directory (): string { return this.root }
  handoffKey (context: AgentContext, target: string): string {
    return createHash('sha256').update(JSON.stringify([context, target])).digest('hex')
  }
  async loadHandoff (key: string): Promise<string | undefined> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid handoff key')
    try {
      const data = JSON.parse(await fs.readFile(path.join(this.root, 'handoffs', key + '.json'), 'utf8'))
      if (data.version !== 1 || typeof data.id !== 'string') throw new Error('Invalid handoff record')
      return data.id
    } catch (error: any) { if (error.code === 'ENOENT') return undefined; throw error }
  }
  saveHandoff (key: string, id: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid handoff key')
    return this.write(path.join(this.root, 'handoffs', key + '.json'), JSON.stringify({ version: 1, id }))
  }
  async lockNativeSession (id: string): Promise<() => Promise<void>> {
    const directory = path.join(this.root, 'locks')
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const file = path.join(directory, createHash('sha256').update(id).digest('hex') + '.lock')
    const token = randomBytes(16).toString('hex')
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await fs.open(file, 'wx', 0o600)
        try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })) } finally { await handle.close() }
        return async () => {
          try { if (JSON.parse(await fs.readFile(file, 'utf8')).token === token) await fs.unlink(file) }
          catch (error: any) { if (error.code !== 'ENOENT') throw error }
        }
      } catch (error: any) {
        if (error.code !== 'EEXIST') throw error
        // Serialize stale-lock recovery, then reread ownership. Two recovering
        // windows must never unlink a fresh lock acquired by the other window.
        let recovery
        try { recovery = await fs.open(file + '.recovery', 'wx', 0o600) } catch { throw new Error('Session is in use by another window') }
        try {
          let owner: { pid: number }
          try { owner = JSON.parse(await fs.readFile(file, 'utf8')) } catch (missing: any) {
            if (missing.code === 'ENOENT') continue
            throw new Error('Session lock is being initialized; reconnect before retrying')
          }
          if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('Invalid session lock; inspect it before continuing')
          try { process.kill(owner.pid, 0); throw new Error('Session is in use by another window') }
          catch (failure: any) {
            if (failure.code !== 'ESRCH') throw failure
            await fs.unlink(file)
          }
        } finally { await recovery.close(); await fs.unlink(file + '.recovery') }
      }
    }
    throw new Error('Session is in use by another window')
  }
  piDirectory (id: string): string { this.file(id); return path.join(this.root, 'pi', id) }
  private file (id: string): string {
    if (!/^api-[a-f0-9]{32}$/.test(id)) throw new Error('无效的 API 会话 ID')
    return path.join(this.root, id + '.json')
  }
  async load (id: string): Promise<ApiSession> {
    if ((await fs.stat(this.file(id))).size > 32 * 1024 * 1024) throw new Error('API 会话文件过大，请新建会话')
    const data = JSON.parse(await fs.readFile(this.file(id), 'utf8'))
    if (data.instructions !== undefined) validateInstructionsSnapshot(data.instructions)
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
  async loadNativeSession (id: string): Promise<{ version: 1; id: string; cwd: string; spaceKey: string; instructions: InstructionsSnapshot } | undefined> {
    const file = path.join(this.root, 'native-index', createHash('sha256').update(id).digest('hex') + '.json')
    try {
      if ((await fs.stat(file)).size > 512 * 1024) throw new Error('Native session metadata is too large')
      const data = JSON.parse(await fs.readFile(file, 'utf8'))
      if (data.version !== 1 || data.id !== id || typeof data.cwd !== 'string' || typeof data.spaceKey !== 'string') throw new Error('Invalid native session metadata')
      validateInstructionsSnapshot(data.instructions)
      return data
    } catch (error: any) { if (error.code === 'ENOENT') return undefined; throw error }
  }
  saveNativeSession (id: string, cwd: string, spaceKey: string, instructions: InstructionsSnapshot): Promise<void> {
    validateInstructionsSnapshot(instructions)
    return this.write(path.join(this.root, 'native-index', createHash('sha256').update(id).digest('hex') + '.json'), JSON.stringify({ version: 1, id, cwd, spaceKey, instructions }))
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
