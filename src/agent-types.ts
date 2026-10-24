import { EventEmitter } from 'events'
import type { AgentSettings } from './config'
import type { CodexModel, SavedSession, SessionPage, ThreadConfiguration } from './codex.service'

export type ApiProvider = 'openai' | 'deepseek' | 'glm' | 'claude'
export type ApiKeySource = 'direct' | 'environment' | 'vault'
export interface ApiProfile {
  id: string
  /** Local CLI engine; never send this profile to an HTTP API adapter. */
  runtime?: 'claude-code'
  name: string
  provider: ApiProvider
  baseUrl: string
  model: string
  apiKeyEnv: string
  useVault: boolean
  keySource?: ApiKeySource
  apiKey?: string
  thinking: 'default' | 'enabled' | 'disabled'
  reasoningEffort: string
  contextWindow: number
  maxOutputTokens: number
  /** Maximum tool rounds per turn; 0 means no fixed limit. */
  maxIterations: number
  threads: Record<string, string>
}

export function apiKeySource (profile: ApiProfile): ApiKeySource {
  return profile.keySource || (profile.useVault ? 'vault' : 'environment')
}

export interface AgentContext {
  sourceThreadId: string
  sourceFingerprint: string
  cwd: string
  messages: { role: 'user' | 'assistant'; content: string }[]
  turns: { id: string; status: 'completed' | 'interrupted' | 'failed'; items: any[] }[]
  totalTokens: number
  goal?: { objective: string; status: string; tokenBudget: number; usedTokens: number }
}

/** Transitional UI port. Provider HTTP adapters never depend on this event shape. */
export interface AgentClient extends EventEmitter {
  readonly isConnected: boolean
  request(method: string, params?: any): Promise<any>
  respond(id: number, result: any): void
  respondError(id: number, message: string): void
  close(): void
}
export interface AgentBackend {
  readonly client: AgentClient
  readonly profile?: ApiProfile
  getThreadConfiguration(threadId: string): ThreadConfiguration | undefined
  connect(settings: AgentSettings): Promise<void>
  openThread(cwd: string, settings: AgentSettings, savedId?: string): Promise<string>
  resumeThread(threadId: string, cwd: string, settings: AgentSettings): Promise<string>
  listSessions(cwd: string, cursor?: string | null): Promise<SessionPage>
  listModels(): Promise<CodexModel[]>
  exportContext?(threadId: string): Promise<AgentContext>
  importContext?(context: AgentContext, cwd: string, settings: AgentSettings): Promise<string>
  inheritedTurns?(threadId: string): Promise<AgentContext['turns']>
  setGoal(threadId: string, objective: string, budget: number): Promise<void>
  getGoal(threadId: string): Promise<any>
  startTurn(threadId: string, text: string, cwd: string, settings: AgentSettings, terminalOutput?: string): Promise<string>
  steer(threadId: string, turnId: string, text: string): Promise<void>
  interrupt(threadId: string, turnId: string): Promise<void>
}

export const PROVIDER_URLS: Record<ApiProvider, string> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com',
  glm: 'https://open.bigmodel.cn/api/paas/v4',
  claude: 'https://api.anthropic.com/v1',
}
export const PROVIDER_ENV: Record<ApiProvider, string> = {
  openai: 'OPENAI_API_KEY', deepseek: 'DEEPSEEK_API_KEY', glm: 'ZAI_API_KEY', claude: 'ANTHROPIC_API_KEY',
}

/** Zero disables the fixed tool-round limit; token budgets and cancellation still apply. */
export function apiToolRoundLimit (value: unknown): number {
  const limit = Number(value)
  return Number.isFinite(limit) ? Math.floor(Math.max(0, Math.min(100, limit))) : 0
}

export function normalizeApiProfile (configured: ApiProfile): ApiProfile {
  return { ...configured, threads: configured.threads || {}, baseUrl: configured.baseUrl?.trim() || PROVIDER_URLS[configured.provider],
    model: configured.model?.trim() || '', thinking: configured.thinking || 'default', reasoningEffort: configured.reasoningEffort || '',
    maxOutputTokens: Math.floor(Math.max(256, Math.min(131072, Number(configured.maxOutputTokens) || 4096))),
    maxIterations: apiToolRoundLimit(configured.maxIterations) }
}
export type { SavedSession }
