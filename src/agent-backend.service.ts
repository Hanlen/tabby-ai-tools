import { Injectable } from '@angular/core'
import { ConfigService, PlatformService } from 'tabby-core'
import * as path from 'path'
import { AgentBackend, ApiProfile, normalizeApiProfile } from './agent-types'
import { CodexService } from './codex.service'
import { AgentSecretsService } from './agent-secrets.service'
import { AgentStore } from './agent-store'
import { ApiAgent } from './api-agent'
import { TaskMemoryService } from './task-memory.service'

@Injectable()
export class AgentBackendFactory {
  constructor (private config: ConfigService, private codex: CodexService, private secrets: AgentSecretsService, private platform: PlatformService, readonly memory?: TaskMemoryService) {}

  get defaultProfileId (): string { return this.config.store.codexAgent.defaultProfileId || '' }

  create (id = ''): AgentBackend {
    const configPath = this.platform.getConfigPath()
    const store = configPath ? new AgentStore(path.join(path.dirname(configPath), 'tabby-agent-sessions')) : undefined
    if (store) this.codex.setContextStore?.(store)
    if (!id) return this.codex
    const configured = (this.config.store.codexAgent.apiProfiles as ApiProfile[] || []).find(profile => profile.id === id)
    if (!configured) throw new Error('找不到所选 API 连接，请重新选择')
    const profile = normalizeApiProfile(configured)
    if (!store) throw new Error('无法定位 Tabby 配置目录，API 会话需要持久化存储')
    return new ApiAgent(profile, store, () => this.secrets.read(profile))
  }
}
