import { Injectable } from '@angular/core'
import { ConfigService, PlatformService } from 'tabby-core'
import * as path from 'path'
import * as os from 'os'
import { promises as fs } from 'fs'
import { AgentBackend, ApiProfile, normalizeApiProfile } from './agent-types'
import { CodexService } from './codex.service'
import { AgentSecretsService } from './agent-secrets.service'
import { AgentStore } from './agent-store'
import { ApiAgent } from './api-agent'
import { PiBackend, probePiModel } from './pi-agent'
import { ClaudeCodeAgent, CLAUDE_CODE_ID, claudeCodeProfile, probeClaudeCodeModel } from './claude-code-agent'
import { TaskMemoryService } from './task-memory.service'
import type { ScheduledTasksService } from './scheduled-tasks.service'
import type { AgentSettings } from './config'
import { ModelProbeResult, probeApiModel, probeCodexModel, runModelProbe } from './model-probe'
import { NativeEngine, NativeSessionSpace, resolveSessionSpace, sessionSpaceConfig, spaceThreads } from './session-space'

@Injectable()
export class AgentBackendFactory {
  scheduler?: ScheduledTasksService
  constructor (private config: ConfigService, private codex: CodexService, private secrets: AgentSecretsService, private platform: PlatformService, readonly memory?: TaskMemoryService) {}

  get defaultProfileId (): string { return this.config.store.codexAgent.defaultProfileId || '' }

  nativeSpace (engine: NativeEngine): NativeSessionSpace {
    const settings = this.config.store.codexAgent as AgentSettings
    const configPath = this.platform.getConfigPath()
    return resolveSessionSpace(configPath ? path.join(path.dirname(configPath), 'tabby-agent-sessions') : undefined, engine, sessionSpaceConfig(settings, engine))
  }

  /** Selection metadata only: never expose keys, URLs, environment names or session IDs. */
  modelConnections (): { profileId: string; name: string; provider: string; model: string; reasoningEffort: string }[] {
    const settings = this.config.store.codexAgent as AgentSettings
    return [{ profileId: '', name: 'Codex（本机登录）', provider: 'codex', model: settings.model || '', reasoningEffort: settings.reasoningEffort || '' },
      { profileId: CLAUDE_CODE_ID, name: 'Claude Code（本机登录）', provider: 'claude-code', model: settings.claudeModel || 'sonnet', reasoningEffort: settings.claudeReasoningEffort || '' },
      ...(settings.apiProfiles || []).map(profile => ({ profileId: profile.id, name: profile.name, provider: profile.piConnection?.mode === 'native' ? profile.piConnection.providerId : profile.piConnection ? 'pi-custom' : profile.provider, model: profile.model || '', reasoningEffort: profile.reasoningEffort || '' }))]
  }

  async probeModel (profileId: string, settings: AgentSettings, signal?: AbortSignal): Promise<ModelProbeResult> {
    return runModelProbe(settings, async (testSignal, reportUsage) => {
      if (!profileId) return probeCodexModel(settings, testSignal, undefined, reportUsage, this.nativeSpace('codex'))
      if (profileId === CLAUDE_CODE_ID) return probeClaudeCodeModel(
        { ...claudeCodeProfile(this.config.store.codexAgent), model: settings.model, reasoningEffort: settings.reasoningEffort },
        settings.claudeExecutable || this.config.store.codexAgent.claudeExecutable || 'claude', testSignal, reportUsage, this.nativeSpace('claude-code'))
      const configured = (this.config.store.codexAgent.apiProfiles as ApiProfile[] || []).find(profile => profile.id === profileId)
      if (!configured) throw new Error('找不到所选 API 连接')
      const profile = normalizeApiProfile({ ...configured, model: settings.model, reasoningEffort: settings.reasoningEffort })
      if (profile.runtime === 'pi') return probePiModel(profile, () => this.secrets.read(profile), testSignal, reportUsage)
      return probeApiModel(profile, () => this.secrets.read(profile), testSignal, reportUsage)
    }, signal)
  }

  async createDecision (id: string, settings: AgentSettings): Promise<{ backend: AgentBackend; dispose: () => Promise<void> }> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tabby-workflow-decision-'))
    try {
      const backend = this.create(id, true, { model: settings.model, reasoningEffort: settings.reasoningEffort }, new AgentStore(directory))
      return { backend, dispose: async () => { backend.client.close(); await fs.rm(directory, { recursive: true, force: true }) } }
    } catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error }
  }

  create (id = '', isolated = false, override?: Pick<ApiProfile, 'model' | 'reasoningEffort'>, storeOverride?: AgentStore): AgentBackend {
    const configPath = this.platform.getConfigPath()
    const store = storeOverride || (configPath ? new AgentStore(path.join(path.dirname(configPath), 'tabby-agent-sessions')) : undefined)
    if (!id) {
      const space = this.nativeSpace('codex')
      const backend = isolated || space.native ? new CodexService() : this.codex
      backend.sessionSpace = space
      backend.sessionThreads = spaceThreads(this.config.store.codexAgent, 'codex', space)
      const scoped = !storeOverride && space.root ? new AgentStore(path.join(space.root, 'index')) : store
      if (scoped) backend.setContextStore?.(scoped)
      return backend
    }
    if (id === CLAUDE_CODE_ID) {
      if (!store) throw new Error('无法定位 Tabby 配置目录，Claude Code 会话需要持久化存储')
      const space = this.nativeSpace('claude-code')
      const scoped = !storeOverride && space.root ? new AgentStore(path.join(space.root, 'index')) : store
      const backend = new ClaudeCodeAgent({ ...claudeCodeProfile(this.config.store.codexAgent), ...override }, scoped, this.config.store.codexAgent.claudeExecutable || 'claude', space)
      backend.sessionThreads = spaceThreads(this.config.store.codexAgent, 'claude-code', space)
      return backend
    }
    const configured = (this.config.store.codexAgent.apiProfiles as ApiProfile[] || []).find(profile => profile.id === id)
    if (!configured) throw new Error('找不到所选 API 连接，请重新选择')
    const profile = normalizeApiProfile({ ...configured, ...override })
    if (!store) throw new Error('无法定位 Tabby 配置目录，API 会话需要持久化存储')
    return profile.runtime === 'pi' ? new PiBackend(profile, store, () => this.secrets.read(profile)) : new ApiAgent(profile, store, () => this.secrets.read(profile))
  }
}
