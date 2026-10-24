import type { ApiProfile } from './agent-types'
import type { AgentSettings } from './config'

export const CLAUDE_CODE_ID = 'claude-code'

export function claudeCodeProfile (settings: AgentSettings): ApiProfile {
  if (!settings.claudeThreads) settings.claudeThreads = {}
  return { id: CLAUDE_CODE_ID, runtime: 'claude-code', name: 'Claude Code（本机登录）', provider: 'claude', baseUrl: 'local://claude-code',
    model: settings.claudeModel?.trim() || 'sonnet', reasoningEffort: settings.claudeReasoningEffort || '', apiKeyEnv: '', useVault: false,
    thinking: 'default', contextWindow: 0, maxOutputTokens: 4096, maxIterations: 0, threads: settings.claudeThreads }
}
