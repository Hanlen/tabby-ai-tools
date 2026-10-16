import { Injectable } from '@angular/core'
import { CodexClient } from './codex-client'
import { AgentSettings } from './config'
import { TAB_TOOLS } from './tab-tools'

export interface SavedSession {
  id: string
  cwd: string
  name?: string | null
  preview?: string
  updatedAt: number
  originator?: string | null
}

export interface SessionPage {
  data: SavedSession[]
  nextCursor: string | null
}

export interface CodexModel {
  model: string
  displayName: string
  description?: string
  isDefault?: boolean
  hidden?: boolean
  defaultReasoningEffort?: string
  supportedReasoningEfforts?: { reasoningEffort: string; description: string }[]
}

export interface ThreadConfiguration { model: string | null; reasoningEffort: string | null }

@Injectable()
export class CodexService {
  readonly client = new CodexClient()
  private readonly threadConfigurations = new Map<string, ThreadConfiguration>()

  getThreadConfiguration (threadId: string): ThreadConfiguration | undefined {
    return this.threadConfigurations.get(threadId)
  }

  private rememberThreadConfiguration (result: any, settings: AgentSettings): void {
    this.threadConfigurations.set(result.thread.id, {
      model: result.model || result.thread.model || settings.model || null,
      reasoningEffort: result.reasoningEffort ?? result.thread.reasoningEffort ?? settings.reasoningEffort ?? null,
    })
  }

  async connect (settings: AgentSettings): Promise<void> {
    await this.client.connect(settings.executable.trim() || 'codex')
  }

  async openThread (cwd: string, settings: AgentSettings, savedId?: string): Promise<string> {
    if (savedId && settings.tabToolThreads?.[cwd] === savedId) {
      return this.resumeThread(savedId, cwd, settings)
    }
    const params: any = {
      cwd,
      approvalPolicy: settings.approvalPolicy,
      sandbox: settings.sandbox,
      serviceName: 'tabby_codex_agent',
      dynamicTools: TAB_TOOLS,
    }
    if (settings.model.trim()) params.model = settings.model.trim()
    if (settings.reasoningEffort) params.config = { model_reasoning_effort: settings.reasoningEffort }
    const result = await this.client.request('thread/start', params)
    this.rememberThreadConfiguration(result, settings)
    if (!settings.tabToolThreads) settings.tabToolThreads = {}
    settings.tabToolThreads[cwd] = result.thread.id
    return result.thread.id
  }

  async listSessions (cwd: string, cursor: string | null = null): Promise<SessionPage> {
    const seenCursors = new Set<string>()
    if (cursor) seenCursors.add(cursor)
    do {
      // Some app-server versions record custom clients as vscode rather than appServer.
      // Originator identifies our sessions independently of that source classification.
      const page = await this.client.request('thread/list', {
        cwd, cursor, limit: 100, sortKey: 'updated_at', sortDirection: 'desc', sourceKinds: ['cli', 'vscode', 'appServer'],
      })
      const data = (page.data || []).filter((thread: SavedSession) => thread.originator === 'tabby_codex_agent')
      cursor = page.nextCursor || null
      if (cursor) {
        if (seenCursors.has(cursor)) throw new Error('会话列表返回了重复分页游标')
        seenCursors.add(cursor)
      }
      if (data.length || !cursor) return { data, nextCursor: cursor }
    } while (cursor)
    return { data: [], nextCursor: null }
  }

  async listModels (): Promise<CodexModel[]> {
    const models: CodexModel[] = []
    let cursor: string | null = null
    do {
      const page: { data: CodexModel[]; nextCursor: string | null } = await this.client.request('model/list', { cursor })
      models.push(...(page.data || []).filter(model => !model.hidden && model.model))
      cursor = page.nextCursor || null
    } while (cursor)
    return models
  }

  async resumeThread (threadId: string, cwd: string, settings: AgentSettings): Promise<string> {
    const params: any = { threadId, cwd, approvalPolicy: settings.approvalPolicy, sandbox: settings.sandbox, excludeTurns: true }
    if (settings.model.trim()) params.model = settings.model.trim()
    if (settings.reasoningEffort) params.config = { model_reasoning_effort: settings.reasoningEffort }
    const result = await this.client.request('thread/resume', params)
    this.rememberThreadConfiguration(result, settings)
    return result.thread.id
  }

  async setGoal (threadId: string, objective: string, budget: number): Promise<void> {
    const params: any = { threadId, objective: objective.slice(0, 4000), status: 'active' }
    if (budget > 0) params.tokenBudget = budget
    await this.client.request('thread/goal/set', params)
  }

  async getGoal (threadId: string): Promise<any> {
    return (await this.client.request('thread/goal/get', { threadId })).goal
  }

  async startTurn (threadId: string, text: string, cwd: string, settings: AgentSettings, terminalOutput = ''): Promise<string> {
    const sandboxPolicy = settings.sandbox === 'danger-full-access'
      ? { type: 'dangerFullAccess' }
      : settings.sandbox === 'read-only'
        ? { type: 'readOnly', networkAccess: false }
        : { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
    const params: any = {
      threadId,
      input: [
        ...(terminalOutput ? [{ type: 'text', text: terminalOutput }] : []),
        { type: 'text', text },
      ],
      cwd,
      approvalPolicy: settings.approvalPolicy,
      sandboxPolicy,
    }
    if (settings.model.trim()) params.model = settings.model.trim()
    if (settings.reasoningEffort) params.effort = settings.reasoningEffort
    const result = await this.client.request('turn/start', params)
    const previous = this.threadConfigurations.get(threadId)
    this.threadConfigurations.set(threadId, {
      model: params.model || previous?.model || null,
      reasoningEffort: params.effort || previous?.reasoningEffort || null,
    })
    return result.turn.id
  }

  async steer (threadId: string, turnId: string, text: string): Promise<void> {
    await this.client.request('turn/steer', {
      threadId, expectedTurnId: turnId, input: [{ type: 'text', text }],
    })
  }

  async interrupt (threadId: string, turnId: string): Promise<void> {
    await this.client.request('turn/interrupt', { threadId, turnId })
  }
}
