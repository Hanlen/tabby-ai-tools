import { Injectable } from '@angular/core'
import { ConfigService, PlatformService } from 'tabby-core'
import * as path from 'path'
import { AgentBackend, ApiProfile, normalizeApiProfile } from './agent-types'
import { CodexService } from './codex.service'
import { AgentSecretsService } from './agent-secrets.service'
import { AgentStore } from './agent-store'
import { ApiAgent } from './api-agent'
import { TaskMemoryService } from './task-memory.service'
import type { ScheduledTasksService } from './scheduled-tasks.service'
import type { AgentSettings } from './config'
import { ModelProbeResult, probeApiModel, probeCodexModel, runModelProbe } from './model-probe'

@Injectable()
export class AgentBackendFactory {
  scheduler?: ScheduledTasksService
  constructor (private config: ConfigService, private codex: CodexService, private secrets: AgentSecretsService, private platform: PlatformService, readonly memory?: TaskMemoryService) {}

  get defaultProfileId (): string { return this.config.store.codexAgent.defaultProfileId || '' }

  /** Selection metadata only: never expose keys, URLs, environment names or session IDs. */
  modelConnections (): { profileId: string; name: string; provider: string; model: string; reasoningEffort: string }[] {
    const settings = this.config.store.codexAgent as AgentSettings
    return [{ profileId: '', name: 'Codex（本机登录）', provider: 'codex', model: settings.model || '', reasoningEffort: settings.reasoningEffort || '' },
      ...(settings.apiProfiles || []).map(profile => ({ profileId: profile.id, name: profile.name, provider: profile.provider, model: profile.model || '', reasoningEffort: profile.reasoningEffort || '' }))]
  }

  async probeModel (profileId: string, settings: AgentSettings, signal?: AbortSignal): Promise<ModelProbeResult> {
    return runModelProbe(settings, async (testSignal, reportUsage) => {
      if (!profileId) return probeCodexModel(settings, testSignal, undefined, reportUsage)
      const configured = (this.config.store.codexAgent.apiProfiles as ApiProfile[] || []).find(profile => profile.id === profileId)
      if (!configured) throw new Error('找不到所选 API 连接')
      const profile = normalizeApiProfile({ ...configured, model: settings.model, reasoningEffort: settings.reasoningEffort })
      return probeApiModel(profile, () => this.secrets.read(profile), testSignal, reportUsage)
    }, signal)
  }

  create (id = '', isolated = false): AgentBackend {
    const configPath = this.platform.getConfigPath()
    const store = configPath ? new AgentStore(path.join(path.dirname(configPath), 'tabby-agent-sessions')) : undefined
    if (!id) {
      const backend = isolated ? new CodexService() : this.codex
      if (store) backend.setContextStore?.(store)
      return backend
    }
    const configured = (this.config.store.codexAgent.apiProfiles as ApiProfile[] || []).find(profile => profile.id === id)
    if (!configured) throw new Error('找不到所选 API 连接，请重新选择')
    const profile = normalizeApiProfile(configured)
    if (!store) throw new Error('无法定位 Tabby 配置目录，API 会话需要持久化存储')
    return new ApiAgent(profile, store, () => this.secrets.read(profile))
  }
}
