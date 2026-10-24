import { ConfigProvider } from 'tabby-core'
import type { ApiProfile } from './agent-types'

export interface AgentSettings {
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
      openOnStartup: true,
      language: 'auto',
    } as AgentSettings,
  }
}
