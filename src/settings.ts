import { ChangeDetectorRef, Component, Injectable, NgZone, OnDestroy } from '@angular/core'
import { ConfigService } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'
import { AgentSettings } from './config'
import { ApiProfile, ApiProvider, ApiKeySource, apiKeySource, normalizeApiProfile, PROVIDER_ENV, PROVIDER_URLS } from './agent-types'
import { AgentSecretsService } from './agent-secrets.service'
import { agentId } from './agent-store'
import { apiUrl, withAbort } from './api-transport'
import { ApiProviderAdapter } from './api-provider'
import { discoverApiModels } from './api-models'
import type { CodexModel } from './codex.service'
import { TaskMemoryService } from './task-memory.service'
import { TaskWorkflow, TaskPreference, workflowInstructions } from './task-memory'
import { Subscription } from 'rxjs'
import { ScheduledTasksService } from './scheduled-tasks.service'
import { ScheduleDocument, ScheduledTask, ScheduledRun, activeRun } from './scheduled-tasks'
import { formatDateTime, getLanguage, SUPPORTED_LANGUAGES, textDirection, translate } from './i18n'

@Component({ template: require('./settings.pug'), styles: [require('./settings.css')] })
export class CodexSettingsComponent implements OnDestroy {
  readonly t = translate
  readonly languages = SUPPORTED_LANGUAGES
  get direction (): string { return textDirection() }
  get languageCode (): string { return getLanguage() }
  selectedProfileId = ''
  advancedOpen = false
  memoryOpen = false
  schedulesOpen = false
  scheduleLoading = false
  scheduleSaving = false
  scheduleNotice = ''
  scheduleDeleteId = ''
  scheduleData: ScheduleDocument = { version: 1, tasks: [], runs: [] }
  private scheduleSubscription?: Subscription
  memoryLoading = false
  memorySaving = false
  memoryNotice = ''
  memoryWorkflows: TaskWorkflow[] = []
  memoryPreferences: TaskPreference[] = []
  workflowDraftId = ''
  workflowTitle = ''
  workflowObjective = ''
  workflowInstructions = ''
  workflowEnabled = true
  preferenceDraft = ''
  preferenceDraftId = ''
  preferenceScope = 'global'
  preferenceCwd = ''
  readonly providerNames: Record<ApiProvider, string> = { openai: 'OpenAI', deepseek: 'DeepSeek', glm: 'GLM · 智谱', claude: 'Claude' }
  notice = ''
  connectionTests: Record<string, { running: boolean; notice: string }> = {}
  modelLists: Record<string, { running: boolean; notice: string; models: CodexModel[] }> = {}
  private fetchingModels = new Map<string, AbortController>()
  private testing = new Map<string, AbortController>()
  private destroyed = false
  get settings (): AgentSettings { return this.config.store.codexAgent as AgentSettings }
  get profiles (): ApiProfile[] { return this.settings.apiProfiles || [] }
  get selectedProfile (): ApiProfile | undefined { return this.profiles.find(profile => profile.id === this.selectedProfileId) }
  constructor (public config: ConfigService, private secrets: AgentSecretsService, private zone: NgZone, private changeDetector?: ChangeDetectorRef, private memory?: TaskMemoryService, private schedules?: ScheduledTasksService) {
    this.selectedProfileId = this.profiles.find(profile => profile.id === this.settings.defaultProfileId)?.id || this.profiles[0]?.id || ''
    this.scheduleSubscription = this.schedules?.changes$.subscribe(data => this.zone.run(() => {
      if (this.destroyed) return
      this.scheduleData = data
      if (!data.tasks.some(task => task.id === this.scheduleDeleteId)) this.scheduleDeleteId = ''
      this.changeDetector?.markForCheck()
    }))
  }
  selectProfile (id: string): void {
    this.memoryOpen = false
    this.schedulesOpen = false
    this.scheduleDeleteId = ''
    this.selectedProfileId = id
    this.advancedOpen = false
  }
  async openMemory (): Promise<void> {
    this.schedulesOpen = false
    this.scheduleDeleteId = ''
    this.memoryOpen = true
    this.memoryNotice = ''
    await this.refreshMemory()
  }
  async openSchedules (): Promise<void> {
    this.memoryOpen = false
    this.schedulesOpen = true
    this.scheduleDeleteId = ''
    await this.refreshSchedules()
  }
  async refreshSchedules (): Promise<void> {
    this.scheduleLoading = true
    this.scheduleNotice = ''
    try {
      if (!this.schedules) throw new Error('定时任务暂不可用')
      await this.schedules.refresh()
    } catch (error: any) { this.scheduleNotice = `读取失败：${error.message}` }
    finally { this.zone.run(() => { this.scheduleLoading = false; if (!this.destroyed) this.changeDetector?.detectChanges() }) }
  }
  scheduleDescription (task: ScheduledTask): string {
    const s = task.schedule
    return s.type === 'daily' ? `每日 ${s.time}（${s.timezone}）` : s.type === 'interval' ? `每 ${s.minutes} 分钟` : `单次 ${this.scheduleTime(s.at)}`
  }
  scheduleTime (time?: number | null): string { return time ? formatDateTime(time) : '无后续计划' }
  scheduleRun (task: ScheduledTask): ScheduledRun | undefined { return this.scheduleData.runs.find(run => run.taskId === task.id && activeRun(run)) }
  scheduleLastRun (task: ScheduledTask): ScheduledRun | undefined { return this.scheduleData.runs.find(run => run.id === task.lastRunId) }
  scheduleStatus (task: ScheduledTask): string {
    if (this.scheduleRun(task)) return '运行中'
    const run = this.scheduleLastRun(task)
    if (!task.enabled && run && run.status !== 'completed') return '已暂停 · 需检查执行记录'
    return task.enabled ? '已启用' : task.schedule.type === 'at' && task.nextRunAt === null ? '单次已触发' : '已暂停'
  }
  async scheduleAction (action: 'toggle' | 'stop' | 'delete', task: ScheduledTask): Promise<void> {
    if (this.scheduleSaving || !this.schedules) return
    if (action === 'delete' && this.scheduleDeleteId !== task.id) return
    this.scheduleSaving = true
    this.scheduleNotice = ''
    try {
      if (action === 'delete') {
        await this.schedules.remove(task.id, task.cwd)
        this.scheduleDeleteId = ''
        this.scheduleNotice = '任务及执行记录已删除，重启后不会重新加载'
      } else if (action === 'toggle') {
        await this.schedules.setEnabled(task.id, task.cwd, !task.enabled)
        this.scheduleNotice = task.enabled ? '已暂停后续触发' : '已恢复定时'
      } else {
        const run = this.scheduleRun(task)
        if (run) this.schedules.stopRun(run.id)
        this.scheduleNotice = '已请求停止，请等待本次运行结束后再删除'
      }
    } catch (error: any) { this.scheduleNotice = `操作失败：${error.message}` }
    finally { this.zone.run(() => { this.scheduleSaving = false; if (!this.destroyed) this.changeDetector?.detectChanges() }) }
  }
  async refreshMemory (): Promise<void> {
    this.memoryLoading = true
    try {
      if (!this.memory) throw new Error('任务流程库暂不可用')
      const data = await this.memory.library.store.read()
      this.zone.run(() => { this.memoryWorkflows = data.workflows; this.memoryPreferences = data.preferences })
    } catch (error: any) { this.memoryNotice = `读取失败：${error.message}` }
    finally { this.zone.run(() => { this.memoryLoading = false; this.changeDetector?.detectChanges() }) }
  }
  setTaskMemory (enabled: boolean): void {
    this.settings.taskMemoryEnabled = enabled
    if (!enabled) this.memory?.activeLibrary?.clearRuns()
    this.save()
  }
  editWorkflow (workflow: TaskWorkflow): void {
    this.workflowDraftId = workflow.id
    this.workflowTitle = workflow.title
    this.workflowObjective = workflow.objective
    this.workflowInstructions = workflowInstructions(workflow)
    this.workflowEnabled = workflow.enabled
  }
  private async changeMemory (operation: () => Promise<void>, notice: string): Promise<void> {
    if (this.memorySaving) return
    this.memorySaving = true
    this.memoryNotice = ''
    try {
      await operation()
      await this.refreshMemory()
      this.memoryNotice = notice
    } catch (error: any) { this.memoryNotice = `保存失败：${error.message}` }
    finally { this.zone.run(() => { this.memorySaving = false; this.changeDetector?.detectChanges() }) }
  }
  async saveWorkflow (): Promise<void> {
    const workflow = this.memoryWorkflows.find(item => item.id === this.workflowDraftId)
    if (!workflow || !this.memory) return
    await this.changeMemory(() => this.memory!.library.saveWorkflow(workflow, this.workflowTitle, this.workflowObjective, this.workflowInstructions, this.workflowEnabled), '流程已保存；后续自动归档会保留你的修改')
  }
  async removeWorkflow (workflow: TaskWorkflow): Promise<void> {
    await this.changeMemory(async () => {
      await this.memory!.library.removeWorkflow(workflow.id)
      if (this.workflowDraftId === workflow.id) this.workflowDraftId = ''
    }, '流程已删除')
  }
  editPreference (preference: TaskPreference): void {
    this.preferenceDraftId = preference.id
    this.preferenceDraft = preference.text
    this.preferenceScope = preference.cwd ? 'workspace' : 'global'
    this.preferenceCwd = preference.cwd
  }
  async savePreference (): Promise<void> {
    if (this.preferenceScope === 'workspace' && !this.preferenceCwd.trim()) { this.memoryNotice = '请填写偏好适用的完整工作目录'; return }
    await this.changeMemory(async () => {
      await this.memory!.library.savePreference(this.preferenceDraftId, this.preferenceDraft, this.preferenceScope === 'workspace' ? this.preferenceCwd.trim() : '')
      this.preferenceDraft = ''
      this.preferenceDraftId = ''
    }, '操作偏好已保存')
  }
  async removePreference (preference: TaskPreference): Promise<void> {
    await this.changeMemory(async () => {
      await this.memory!.library.removePreference(preference.id)
      if (this.preferenceDraftId === preference.id) { this.preferenceDraftId = ''; this.preferenceDraft = '' }
    }, '操作偏好已删除')
  }
  trackProfile (_index: number, profile: ApiProfile): string { return profile.id }
  setDefault (id: string): void {
    this.settings.defaultProfileId = id
    this.save()
  }
  save (): void { void this.config.save().catch(() => this.zone.run(() => { this.notice = '保存配置失败，请检查配置目录' })) }
  addProfile (): void {
    if (!this.settings.apiProfiles) this.settings.apiProfiles = []
    const profile: ApiProfile = { id: agentId(), name: this.t('新的 API 连接'), provider: 'openai', baseUrl: PROVIDER_URLS.openai,
      model: '', apiKeyEnv: PROVIDER_ENV.openai, useVault: false, keySource: 'direct', apiKey: '', thinking: 'default', reasoningEffort: '', contextWindow: 0,
      maxOutputTokens: 4096, maxIterations: 0, threads: {} }
    this.settings.apiProfiles.push(profile)
    this.selectProfile(profile.id)
    this.save()
  }
  removeProfile (profile: ApiProfile): void {
    const index = this.profiles.findIndex(item => item.id === profile.id)
    this.testing.get(profile.id)?.abort()
    this.clearModelList(profile)
    this.settings.apiProfiles = this.profiles.filter(item => item.id !== profile.id)
    if (this.settings.defaultProfileId === profile.id) this.settings.defaultProfileId = ''
    if (this.selectedProfileId === profile.id) this.selectProfile(this.profiles[Math.min(index, this.profiles.length - 1)]?.id || '')
    delete this.connectionTests[profile.id]
    this.save()
  }
  changeProvider (profile: ApiProfile, provider: ApiProvider): void {
    this.clearModelList(profile)
    profile.provider = provider
    profile.baseUrl = PROVIDER_URLS[provider]
    profile.apiKeyEnv = PROVIDER_ENV[provider]
    profile.model = ''
    profile.thinking = 'default'
    profile.reasoningEffort = ''
    this.save()
  }
  keySource (profile: ApiProfile): ApiKeySource { return apiKeySource(profile) }
  changeKeySource (profile: ApiProfile, source: ApiKeySource): void {
    this.clearModelList(profile)
    profile.keySource = source
    profile.useVault = false
    this.save()
  }
  clearModelList (profile: ApiProfile): void {
    this.fetchingModels.get(profile.id)?.abort()
    this.fetchingModels.delete(profile.id)
    delete this.modelLists[profile.id]
  }
  modelConnectionChanged (profile: ApiProfile): void {
    this.clearModelList(profile)
    this.save()
  }
  async fetchModels (profile: ApiProfile, refresh = false): Promise<void> {
    if (this.fetchingModels.has(profile.id) || (!refresh && this.modelLists[profile.id])) return
    const snapshot = { ...profile }
    const controller = new AbortController()
    this.fetchingModels.set(profile.id, controller)
    const update = (running: boolean, notice: string, models: CodexModel[] = []) => {
      if (this.destroyed || this.fetchingModels.get(profile.id) !== controller) return
      this.zone.run(() => { this.modelLists[profile.id] = { running, notice, models }; this.changeDetector?.detectChanges() })
    }
    update(true, '正在获取模型列表…')
    try {
      const models = await discoverApiModels(snapshot, () => this.secrets.read(snapshot), controller.signal)
      update(false, models.length ? `已获取 ${models.length} 个模型，可选择或手动输入模型 ID` : '服务端未返回可用模型，请手动填写模型 ID', models)
    } catch (error: any) { update(false, `获取模型列表失败：${error.message}`) }
    finally { if (this.fetchingModels.get(profile.id) === controller) this.fetchingModels.delete(profile.id) }
  }
  async testProfile (profile: ApiProfile): Promise<void> {
    if (this.testing.has(profile.id)) return
    const controller = new AbortController()
    const snapshot = { ...profile }
    this.testing.set(profile.id, controller)
    const update = (notice: string, running = true) => {
      if (this.destroyed) return
      this.zone.run(() => { this.connectionTests[profile.id] = { running, notice }; this.changeDetector?.detectChanges() })
    }
    update('正在测试连接…')
    const timeout = setTimeout(() => controller.abort(), 60000)
    const started = Date.now()
    let chunks = 0
    try {
      Object.assign(snapshot, normalizeApiProfile(snapshot))
      if (!snapshot.model.trim()) throw new Error('请填写模型 ID')
      apiUrl(snapshot.baseUrl, snapshot.provider === 'openai' ? 'responses' : snapshot.provider === 'claude' ? 'messages' : 'chat/completions')
      const key = await withAbort(this.secrets.read(snapshot), controller.signal)
      const adapter = new ApiProviderAdapter(snapshot, key)
      await adapter.generate([adapter.user('Reply with OK only.')], 'This is a connection test. Reply briefly and do not call tools.', [], controller.signal,
        () => { chunks++; update(`已收到流式回复（${chunks} 个片段）…`) },
        progress => update(progress.phase === 'thinking' ? `连接已响应，模型正在思考（已接收 ${progress.receivedChars} 字符）…` : '连接已响应…'))
      update(`测试成功：${snapshot.model} · ${Date.now() - started} ms${chunks ? ` · 收到 ${chunks} 个正文流片段` : ' · SSE 响应完成'}`, false)
    } catch (error: any) { update(controller.signal.aborted ? '测试已取消或超时' : `测试失败：${error.message}`, false) }
    finally { clearTimeout(timeout); this.testing.delete(profile.id) }
  }
  cancelTest (profile: ApiProfile): void { this.testing.get(profile.id)?.abort() }
  ngOnDestroy (): void {
    this.destroyed = true
    this.scheduleSubscription?.unsubscribe()
    for (const controller of this.testing.values()) controller.abort()
    for (const controller of this.fetchingModels.values()) controller.abort()
  }
}

@Injectable()
export class CodexSettingsTabProvider extends SettingsTabProvider {
  id = 'codex-agent'
  icon = 'robot'
  title = 'AI Tools'
  getComponentType (): any { return CodexSettingsComponent }
}
