import { ConfigProvider } from 'tabby-core'

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
    } as AgentSettings,
  }
}
