import { EventEmitter } from 'events'
import type { AgentSettings } from './config'
import type { CodexModel, SavedSession, SessionPage, ThreadConfiguration } from './codex.service'

export type ApiProvider = 'openai' | 'deepseek' | 'glm' | 'kimi' | 'kimi-coding' | 'bailian-coding' | 'claude' | 'custom'
export type ApiKeySource = 'direct' | 'environment' | 'vault' | 'none'
export type ApiFormat = 'chat-completions' | 'responses'
export interface ApiProfile {
  id: string
  /** Local CLI engine; never send this profile to an HTTP API adapter. */
  runtime?: 'claude-code' | 'pi'
  /** External Node >=22.19 executable, never the Electron executable. */
  piNodeExecutable?: string
  autoCompact?: boolean
  name: string
  provider: ApiProvider
  /** Custom OpenAI-compatible connections default to Chat Completions. */
  apiFormat?: ApiFormat
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
  /** Distinguishes a user-selected limit from the historical default of 20. */
  toolRoundLimitConfigured?: boolean
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
  readonly runtimeInfo?: string
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
  kimi: 'https://api.moonshot.cn/v1',
  'kimi-coding': 'https://api.kimi.com/coding/v1',
  'bailian-coding': 'https://coding.dashscope.aliyuncs.com/v1',
  claude: 'https://api.anthropic.com/v1',
  custom: '',
}
export const PROVIDER_ENV: Record<ApiProvider, string> = {
  openai: 'OPENAI_API_KEY', deepseek: 'DEEPSEEK_API_KEY', glm: 'ZAI_API_KEY', claude: 'ANTHROPIC_API_KEY',
  kimi: 'MOONSHOT_API_KEY', 'kimi-coding': 'KIMI_API_KEY',
  'bailian-coding': 'BAILIAN_CODING_PLAN_API_KEY',
  custom: 'CUSTOM_API_KEY',
}

export function usesResponsesApi (profile: ApiProfile): boolean {
  if (profile.provider === 'custom' && profile.apiFormat && !['chat-completions', 'responses'].includes(profile.apiFormat)) {
    throw new Error('不支持的自定义 API 协议')
  }
  return profile.provider === 'openai' || profile.provider === 'custom' && profile.apiFormat === 'responses'
}

export function apiPath (profile: ApiProfile): string {
  return usesResponsesApi(profile) ? 'responses' : profile.provider === 'claude' ? 'messages' : 'chat/completions'
}

export const PROVIDER_REGIONS: Partial<Record<ApiProvider, { china: string; international: string }>> = {
  kimi: { china: PROVIDER_URLS.kimi, international: 'https://api.moonshot.ai/v1' },
  'kimi-coding': { china: PROVIDER_URLS['kimi-coding'], international: 'https://api.kimi.ai/coding/v1' },
  'bailian-coding': { china: PROVIDER_URLS['bailian-coding'], international: 'https://coding-intl.dashscope.aliyuncs.com/v1' },
}

export function isKimiProvider (provider: ApiProvider): boolean { return provider === 'kimi' || provider === 'kimi-coding' }

/** These Moonshot models always reason and reject the K2.x thinking parameter. */
export function kimiAlwaysThinks (profile: ApiProfile): boolean {
  return profile.provider === 'kimi' && /^kimi-(k3(?:\.1-pro)?|k2\.7-code)(?:-highspeed)?$/i.test(profile.model)
}

/** Zero disables the fixed tool-round limit; token budgets and cancellation still apply. */
export function apiToolRoundLimit (value: unknown): number {
  const limit = Number(value)
  return Number.isFinite(limit) ? Math.floor(Math.max(0, Math.min(100, limit))) : 0
}

export function configuredToolRoundLimit (profile: ApiProfile): number {
  return Number(profile.maxIterations) === 20 && !profile.toolRoundLimitConfigured ? 0 : apiToolRoundLimit(profile.maxIterations)
}

export function normalizeApiProfile (configured: ApiProfile): ApiProfile {
  if (configured.runtime && !['claude-code', 'pi'].includes(configured.runtime)) throw new Error('不支持的 Agent 运行时')
  return { ...configured, threads: configured.threads || {}, baseUrl: configured.baseUrl?.trim() || PROVIDER_URLS[configured.provider],
    model: configured.model?.trim() || '', thinking: configured.thinking || 'default', reasoningEffort: configured.reasoningEffort || '',
    maxOutputTokens: Math.floor(Math.max(256, Math.min(131072, Number(configured.maxOutputTokens) || 4096))),
    maxIterations: configuredToolRoundLimit(configured) }
}
export type { SavedSession }
