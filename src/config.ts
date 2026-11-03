import { ConfigProvider } from 'tabby-core'
import type { ApiProfile } from './agent-types'
import type { AgentInstructions } from './agent-instructions'
import type { SessionSpaceConfig } from './session-space'

export interface AgentSettings {
  defaultInstructions?: AgentInstructions
  codexInstructions?: AgentInstructions
  claudeInstructions?: AgentInstructions
  cliSessionSpaces?: Record<string, SessionSpaceConfig>
  spaceThreads?: Record<string, Record<string, string>>
  /** Internal isolated decision sessions have no native or Tabby write tools. */
  decisionOnly?: boolean
  workflowHelpers?: Record<string, { model: string; reasoningEffort: string; timeoutMs?: number; maxCalls?: number }>
  claudeExecutable?: string
  claudeModel?: string
  claudeReasoningEffort?: string
  claudeThreads?: Record<string, string>
  executable: string
  cwd: string
  model: string
  reasoningEffort: string
  approvalPolicy: 'on-request' | 'never' | 'untrusted'
  sandbox: 'workspace-write' | 'read-only' | 'danger-full-access'
  goalTokenBudget: number
  threads: Record<string, string>
  tabToolThreads: Record<string, string>
  tabToolVersions?: Record<string, number>
  defaultProfileId?: string
  apiProfiles?: ApiProfile[]
  taskMemoryEnabled?: boolean
  openOnStartup?: boolean
  language?: string
}

export class CodexConfigProvider extends ConfigProvider {
  defaults = {
    codexAgent: {
      executable: 'codex',
      claudeExecutable: 'claude',
      claudeModel: 'sonnet',
      claudeReasoningEffort: '',
      claudeThreads: {},
      cwd: '',
      model: '',
      reasoningEffort: '',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      goalTokenBudget: 0,
      threads: {},
      tabToolThreads: {},
      tabToolVersions: {},
      defaultProfileId: '',
      apiProfiles: [],
      taskMemoryEnabled: true,
      // Tabby must retain mutations to this dynamic per-connection dictionary.
      workflowHelpers: { __nonStructural: true } as unknown as NonNullable<AgentSettings['workflowHelpers']>,
      openOnStartup: true,
      language: 'auto',
      defaultInstructions: { mode: 'none', __nonStructural: true },
      codexInstructions: { mode: 'inherit', __nonStructural: true },
      claudeInstructions: { mode: 'inherit', __nonStructural: true },
      cliSessionSpaces: { __nonStructural: true } as unknown as NonNullable<AgentSettings['cliSessionSpaces']>,
      spaceThreads: { __nonStructural: true } as unknown as NonNullable<AgentSettings['spaceThreads']>,
    } as AgentSettings,
  }
}
