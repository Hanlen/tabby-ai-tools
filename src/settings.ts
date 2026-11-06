import { ChangeDetectorRef, Component, Injectable, NgZone, OnDestroy } from '@angular/core'
import { ConfigService, PlatformService } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'
import { AgentSettings } from './config'
import { ApiProfile, ApiProvider, ApiFormat, ApiKeySource, apiKeySource, apiPath, normalizeApiProfile, PROVIDER_ENV, PROVIDER_URLS, PROVIDER_REGIONS } from './agent-types'
import { AgentSecretsService } from './agent-secrets.service'
import { agentId } from './agent-store'
import { apiUrl, withAbort } from './api-transport'
import { ApiProviderAdapter } from './api-provider'
import { probePiModel, checkPiConfiguration } from './pi-agent'
import { discoverApiModels } from './api-models'
import { piCatalog, piProtocols, piProvider, piModel, piModels, validatePiProfile } from './pi-config'
import type { CodexModel } from './codex.service'
import { TaskMemoryService } from './task-memory.service'
import { TaskWorkflow, TaskPreference, workflowInstructions } from './task-memory'
import { Subscription } from 'rxjs'
import { ScheduledTasksService } from './scheduled-tasks.service'
import { ScheduleDocument, ScheduledTask, ScheduledRun, activeRun } from './scheduled-tasks'
import { formatDateTime, getLanguage, SUPPORTED_LANGUAGES, textDirection, translate } from './i18n'
import { AgentInstructions, InstructionsSnapshot, resolveInstructions, validateInstructions } from './agent-instructions'
import { NativeEngine, SessionSpaceConfig, privateSpaceConfig, sessionSpaceConfig, resolveSessionSpace, prepareSessionSpace, initializeNativeAuth, sessionEnvironment, nativeLoginCommand } from './session-space'
import { CodexClient } from './codex-client'
import { resolveCodexLaunch } from './codex-discovery'
import { inspectClaudeCode, resolveClaudeExecutable } from './claude-code-client'
import * as path from 'path'

@Component({ template: require('./settings.pug'), styles: [require('./settings.css')] })
export class CodexSettingsComponent implements OnDestroy {
  readonly t = translate
  readonly languages = SUPPORTED_LANGUAGES
  get direction (): string { return textDirection() }
  get languageCode (): string { return getLanguage() }
  selectedProfileId = ''
  readonly piCatalog = piCatalog
  readonly piProtocols = piProtocols
  readonly piProvider = piProvider
  readonly piModel = piModel
  providerSearch = ''
  draftNotice = ''
  draftErrors: { field: string; message: string }[] = []
  draftSaving = false
  private drafts = new Map<string, ApiProfile>()
  private providerDrafts = new Map<string, ApiProfile>()
  private modeProviders = new Map<string, string>()
  get persistedProfiles (): ApiProfile[] { return this.settings.apiProfiles || [] }
  isSaved (profile: ApiProfile): boolean { return this.persistedProfiles.some(p => p.id === profile.id) }
  private rememberProvider (profile: ApiProfile): void {
    const mode = profile.piConnection?.mode || 'legacy'
    const id = profile.piConnection?.mode === 'native' ? profile.piConnection.providerId : profile.provider
    this.modeProviders.set(profile.id + ':' + mode, id)
    this.providerDrafts.set(profile.id + ':' + mode + ':' + id, JSON.parse(JSON.stringify(profile)))
  }
  private restoreProvider (profile: ApiProfile, mode: string, id: string): boolean {
    const prior = this.providerDrafts.get(profile.id + ':' + mode + ':' + id)
    if (!prior) return false
    Object.assign(profile, JSON.parse(JSON.stringify(prior)), { name: profile.name })
    if (!prior.piConnection) delete profile.piConnection
    this.modelConnectionChanged(profile); return true
  }
  get piProviders () { const query = this.providerSearch.toLowerCase(); return piCatalog.providers.filter(p => (p.id + ' ' + p.name + (p.id === 'google' ? ' Gemini' : '')).toLowerCase().includes(query)) }
  get dirty (): boolean {
    const draft = this.selectedProfile, saved = this.persistedProfiles.find(p => p.id === this.selectedProfileId)
    return !!draft && (!saved || JSON.stringify({ ...draft, threads: undefined }) !== JSON.stringify({ ...saved, threads: undefined }))
  }
  profileName (profile: ApiProfile): string { return piProvider(profile)?.name || (profile.piConnection?.mode === 'custom' ? 'Pi custom' : this.providerNames[profile.provider]) }
  fieldError (field: string): string { return this.draftErrors.find(e => e.field === field)?.message || '' }
  draftChanged (profile: ApiProfile): void { this.modelConnectionChanged(profile) }
  discardDraft (profile: ApiProfile): void {
    this.instructionDrafts.delete(profile.id)
    this.drafts.delete(profile.id); this.clearModelList(profile); this.testing.get(profile.id)?.abort(); this.testing.delete(profile.id); delete this.connectionTests[profile.id]
    this.draftNotice = ''; this.draftErrors = []
    for (const key of this.providerDrafts.keys()) if (key.startsWith(profile.id + ':')) this.providerDrafts.delete(key)
    for (const key of this.modeProviders.keys()) if (key.startsWith(profile.id + ':')) this.modeProviders.delete(key)
    if (!(this.settings.apiProfiles || []).some(p => p.id === profile.id)) this.selectProfile(this.profiles[0]?.id || '')
  }
  async saveDraft (profile: ApiProfile): Promise<void> {
    if (this.draftSaving) return
    this.draftNotice = ''
    this.draftErrors = []
    try {
      if (!profile.name.trim()) throw new Error('Connection name is required')
      if (!profile.model.trim()) throw new Error('Model ID is required')
      const edit = this.instructionDrafts.get(profile.id)
      if (edit) profile.instructions = this.instructionValue(edit)
      validateInstructions(profile.instructions)
      if (profile.piConnection) validatePiProfile(profile)
      else apiUrl(profile.baseUrl, apiPath(profile))
    } catch (error: any) {
      const message = String(error.message)
      const field = /name/i.test(message) ? 'api-name-' + profile.id : /Model ID/i.test(message) ? 'api-model-' + profile.id : /protocol/i.test(message) ? 'pi-protocol' : /context/i.test(message) ? 'pi-model-context' : /maximum output capability/i.test(message) ? 'pi-model-maximum' : /output budget/i.test(message) ? 'api-output-' + profile.id : /thinking/i.test(message) ? 'api-effort-' + profile.id : /URL|HTTPS|endpoint/i.test(message) ? 'api-url-' + profile.id : 'pi-provider'
      if (field.startsWith('api-output') || field.startsWith('api-effort')) this.advancedOpen = true
      this.draftErrors = [{ field, message }]
      this.draftNotice = message
      setTimeout(() => { if (typeof document !== 'undefined') document.getElementById('connection-draft-status')?.focus() })
      return
    }
    this.draftSaving = true
    const previous = this.settings.apiProfiles || []
    const saved = JSON.parse(JSON.stringify(profile))
    // Thread references may change in a sidebar while this settings draft is open.
    saved.threads = { ...(previous.find(p => p.id === profile.id)?.threads || profile.threads) }
    this.settings.apiProfiles = previous.some(p => p.id === profile.id) ? previous.map(p => p.id === profile.id ? saved : p) : [...previous, saved]
    try {
      await this.config.save()
      profile.threads = { ...saved.threads }
      this.draftNotice = 'Saved locally; account access unverified. Reconnect in the sidebar when idle to apply.'
    } catch {
      this.settings.apiProfiles = previous
      this.draftNotice = 'Save failed; draft retained. Check the configuration directory.'
    } finally { this.draftSaving = false; this.changeDetector?.markForCheck() }
  }
  copyProfile (profile: ApiProfile): void {
    const copy = JSON.parse(JSON.stringify(profile)) as ApiProfile
    copy.id = agentId(); copy.name += ' (copy)'; copy.threads = {}
    this.drafts.set(copy.id, copy); this.selectProfile(copy.id)
  }
  changePiMode (profile: ApiProfile, mode: 'native' | 'custom' | 'legacy'): void {
    this.rememberProvider(profile)
    if (this.restoreProvider(profile, mode, this.modeProviders.get(profile.id + ':' + mode) || (mode === 'native' ? 'google' : profile.provider))) return
    if (mode === 'legacy') { delete profile.piConnection; profile.baseUrl ||= PROVIDER_URLS[profile.provider] }
    else {
      profile.piConnection = mode === 'native' ? { version: 1, mode, providerId: 'google' } : { version: 1, mode, api: 'openai-completions' }
      profile.apiKey = ''; profile.apiKeyEnv = ''
      profile.provider = 'custom'; profile.baseUrl = ''; profile.model = ''; profile.reasoningEffort = ''; profile.thinking = 'default'
      if (mode === 'native' && profile.keySource === 'none') profile.keySource = 'direct'
    }
    this.modelConnectionChanged(profile)
  }
  changePiProvider (profile: ApiProfile, id: string): void {
    this.rememberProvider(profile)
    if (this.restoreProvider(profile, 'native', id)) return
    profile.apiKey = ''; profile.apiKeyEnv = ''
    profile.piConnection = { version: 1, mode: 'native', providerId: id }
    profile.baseUrl = ''; profile.model = ''; profile.reasoningEffort = ''; profile.thinking = 'default'
    this.modelConnectionChanged(profile)
  }
  async checkConfiguration (profile: ApiProfile): Promise<void> {
    if (this.testing.has(profile.id)) return
    const controller = new AbortController(); this.testing.set(profile.id, controller)
    const snapshot = JSON.parse(JSON.stringify(profile))
    this.connectionTests[profile.id] = { running: true, notice: 'Checking local configuration and runtime…' }
    const timer = setTimeout(() => controller.abort(), 20000)
    try {
      const notice = await checkPiConfiguration(snapshot, () => this.secrets.read(snapshot), controller.signal)
      if (this.testing.get(profile.id) === controller && !this.destroyed) this.connectionTests[profile.id] = { running: false, notice }
    } catch (error: any) {
      if (this.testing.get(profile.id) === controller && !this.destroyed) this.connectionTests[profile.id] = { running: false, notice: error.message }
    } finally { clearTimeout(timer); if (this.testing.get(profile.id) === controller) this.testing.delete(profile.id); this.changeDetector?.markForCheck() }
  }
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
  workflowAlias = ''
  workflowTitle = ''
  workflowObjective = ''
  workflowInstructions = ''
  workflowEnabled = true
  workflowPolicies = '{}'
  helperConnectionId = 'codex'
  get helperSettings (): { model: string; reasoningEffort: string; timeoutMs?: number; maxCalls?: number } {
    const helpers = this.settings.workflowHelpers ||= {}
    return helpers[this.helperConnectionId] ||= { model: '', reasoningEffort: '', timeoutMs: 15000, maxCalls: 2 }
  }
  preferenceDraft = ''
  preferenceDraftId = ''
  preferenceScope = 'global'
  preferenceCwd = ''
  readonly providerNames: Record<ApiProvider, string> = { openai: 'OpenAI', deepseek: 'DeepSeek', glm: 'GLM · 智谱', kimi: 'Kimi API', 'kimi-coding': 'Kimi Coding Plan', 'bailian-coding': 'Alibaba Cloud Coding Plan', claude: 'Claude', custom: '自定义（OpenAI 兼容）' }
  readonly providerRegions = PROVIDER_REGIONS
  notice = ''
  connectionTests: Record<string, { running: boolean; notice: string }> = {}
  modelLists: Record<string, { running: boolean; notice: string; models: CodexModel[] }> = {}
  private fetchingModels = new Map<string, AbortController>()
  private testing = new Map<string, AbortController>()
  private destroyed = false
  get settings (): AgentSettings { return this.config.store.codexAgent as AgentSettings }
  instructionScope = 'connection'
  instructionNotice = ''
  instructionPreview?: InstructionsSnapshot
  instructionSaving = false
  private instructionGeneration = 0
  private instructionDrafts = new Map<string, { mode: AgentInstructions['mode']; text: string; path: string }>()
  private spaceDrafts = new Map<NativeEngine, SessionSpaceConfig>()
  nativeNotice = ''
  nativeBusy = false
  nativeCommand = ''
  private nativeCheck?: AbortController
  get nativeEngine (): NativeEngine { return this.claudeCodeSelected ? 'claude-code' : 'codex' }
  private get instructionKey (): string { return this.instructionScope === 'default' ? '__default' : this.selectedProfileId || 'codex' }
  get instructionDraft (): { mode: AgentInstructions['mode']; text: string; path: string } {
    const key = this.instructionKey
    if (!this.instructionDrafts.has(key)) {
      const value = key === '__default' ? this.settings.defaultInstructions : this.selectedProfile ? this.selectedProfile.instructions : this.claudeCodeSelected ? this.settings.claudeInstructions : this.settings.codexInstructions
      this.instructionDrafts.set(key, { mode: value?.mode || (key === '__default' ? 'none' : 'inherit'), text: value?.mode === 'inline' ? value.text : '', path: value?.mode === 'file' ? value.path : '' })
    }
    return this.instructionDrafts.get(key)!
  }
  private instructionValue (draft = this.instructionDraft): AgentInstructions {
    return draft.mode === 'inline' ? { mode: 'inline', text: draft.text } : draft.mode === 'file' ? { mode: 'file', path: draft.path.trim() } : { mode: draft.mode }
  }
  instructionChanged (): void {
    this.instructionGeneration++; this.instructionNotice = ''; this.instructionPreview = undefined
    if (this.instructionScope !== 'default' && this.selectedProfile) this.selectedProfile.instructions = this.instructionValue()
  }
  instructionScopeChanged (): void { this.instructionGeneration++; this.instructionNotice = ''; this.instructionPreview = undefined }
  discardInstructions (): void {
    if (this.instructionScope !== 'default' && this.selectedProfile) {
      const saved = this.persistedProfiles.find(p => p.id === this.selectedProfileId)?.instructions
      if (saved) this.selectedProfile.instructions = JSON.parse(JSON.stringify(saved))
      else delete this.selectedProfile.instructions
    }
    this.instructionDrafts.delete(this.instructionKey); this.instructionGeneration++; this.instructionNotice = ''; this.instructionPreview = undefined
  }
  async chooseInstructionFile (event: Event): Promise<void> {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    try {
      const filePath = (file as File & { path?: string }).path || require('electron').webUtils?.getPathForFile(file)
      if (!filePath) throw new Error('Paste the absolute local file path in this host')
      this.instructionDraft.mode = 'file'; this.instructionDraft.path = filePath; this.instructionChanged()
      await this.previewInstructions()
    } catch (error: any) { this.instructionNotice = error.message } finally { input.value = '' }
  }
  async previewInstructions (): Promise<void> {
    const generation = ++this.instructionGeneration
    const key = this.instructionKey
    try {
      const snapshot = await resolveInstructions(this.instructionValue(), key === '__default' ? undefined : this.settings.defaultInstructions)
      if (generation === this.instructionGeneration && key === this.instructionKey && !this.destroyed) { this.instructionPreview = snapshot; this.instructionNotice = 'Preview ready; no model called.' }
    } catch (error: any) { if (generation === this.instructionGeneration && key === this.instructionKey) this.instructionNotice = error.message }
    finally { this.changeDetector?.markForCheck() }
  }
  async saveInstructions (): Promise<void> {
    if (this.instructionSaving) return
    const key = this.instructionKey, value = this.instructionValue()
    try { validateInstructions(value) } catch (error: any) { this.instructionNotice = error.message; return }
    if (key !== '__default' && this.selectedProfile) { this.selectedProfile.instructions = value; await this.saveDraft(this.selectedProfile); this.instructionNotice = this.draftNotice; return }
    const field = key === '__default' ? 'defaultInstructions' : key === 'claude-code' ? 'claudeInstructions' : 'codexInstructions'
    const previous = this.settings[field]
    this.instructionSaving = true
    this.settings[field] = value
    try { await this.config.save(); this.instructionNotice = 'Saved. New sessions use these instructions; existing sessions keep their snapshot.' }
    catch { this.settings[field] = previous; this.instructionNotice = 'Save failed; draft retained. Check the configuration directory.' }
    finally { this.instructionSaving = false; this.changeDetector?.markForCheck() }
  }
  get nativeSpaceDraft (): SessionSpaceConfig {
    if (!this.spaceDrafts.has(this.nativeEngine)) this.spaceDrafts.set(this.nativeEngine, sessionSpaceConfig(this.settings, this.nativeEngine))
    return this.spaceDrafts.get(this.nativeEngine)!
  }
  changeNativeSpace (mode: 'tabby' | 'system'): void {
    this.spaceDrafts.set(this.nativeEngine, mode === 'system' ? { mode } : privateSpaceConfig(this.nativeEngine))
    this.nativeNotice = ''; this.nativeCommand = ''
  }
  discardNativeSpace (): void { this.spaceDrafts.delete(this.nativeEngine); this.nativeNotice = ''; this.nativeCommand = '' }
  private selectedNativeSpace () {
    const configPath = this.platform?.getConfigPath()
    return resolveSessionSpace(configPath ? path.join(path.dirname(configPath), 'tabby-agent-sessions') : undefined, this.nativeEngine, this.nativeSpaceDraft)
  }
  async saveNativeSpace (): Promise<void> {
    if (this.nativeBusy) return
    const engine = this.nativeEngine, value = { ...this.nativeSpaceDraft }
    const previous = this.settings.cliSessionSpaces
    this.nativeBusy = true
    try {
      const space = this.selectedNativeSpace()
      await prepareSessionSpace(space)
      this.settings.cliSessionSpaces = { ...previous, [engine]: value }
      await this.config.save()
      this.nativeNotice = 'Saved. An empty private CLI space reuses the local login cache. Reconnect when idle; original sessions are retained.'
    } catch (error: any) { this.settings.cliSessionSpaces = previous; this.nativeNotice = error.message }
    finally { this.nativeBusy = false; this.changeDetector?.markForCheck() }
  }
  async checkNativeSpace (loginCommand = false): Promise<void> {
    if (this.nativeBusy) return
    this.nativeBusy = true; this.nativeNotice = ''; this.nativeCommand = ''
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000)
    this.nativeCheck = controller
    const client = new CodexClient()
    const close = () => { void client.close() }
    controller.signal.addEventListener('abort', close, { once: true })
    try {
      const space = this.selectedNativeSpace()
      await prepareSessionSpace(space)
      const executable = space.engine === 'codex' ? (await resolveCodexLaunch(this.settings.executable || 'codex', { signal: controller.signal })).executable : resolveClaudeExecutable(this.settings.claudeExecutable || 'claude')
      if (loginCommand) { this.nativeCommand = nativeLoginCommand(space, executable); this.nativeNotice = 'Run this command in a local terminal, then check login here. The command targets this space only.' }
      else if (space.engine === 'codex') {
        await client.connect(executable, space)
        const result = await client.request('account/read', { refreshToken: false })
        this.nativeNotice = result.account ? 'Selected space is logged in; model access is unverified.' : 'Selected space is not logged in. Generate its login command.'
      } else {
        await initializeNativeAuth(space, process.env)
        await inspectClaudeCode(executable, this.settings.cwd || process.cwd(), controller.signal, sessionEnvironment(space, process.env))
        this.nativeNotice = 'Selected space is logged in; model access is unverified.'
      }
    } catch (error: any) { this.nativeNotice = error.message }
    finally { clearTimeout(timer); controller.signal.removeEventListener('abort', close); await client.close(); this.nativeCheck = undefined; this.nativeBusy = false; if (!this.destroyed) this.changeDetector?.markForCheck() }
  }
  copyNativeCommand (): void { if (this.nativeCommand) this.platform?.setClipboard({ text: this.nativeCommand }) }
  get profiles (): ApiProfile[] { const saved = this.settings.apiProfiles || []; return [...saved, ...[...this.drafts.values()].filter(p => !saved.some(s => s.id === p.id))] }
  get claudeCodeSelected (): boolean { return this.selectedProfileId === 'claude-code' }
  get selectedProfile (): ApiProfile | undefined {
    const profile = this.profiles.find(profile => profile.id === this.selectedProfileId)
    if (!profile) return undefined
    if (!this.drafts.has(profile.id)) this.drafts.set(profile.id, JSON.parse(JSON.stringify(profile)))
    return this.drafts.get(profile.id)
  }
  constructor (public config: ConfigService, private secrets: AgentSecretsService, private zone: NgZone, private changeDetector?: ChangeDetectorRef, private memory?: TaskMemoryService, private schedules?: ScheduledTasksService, private platform?: PlatformService) {
    let migrated = false
    for (const profile of this.profiles) if (Number(profile.maxIterations) === 20 && !profile.toolRoundLimitConfigured) {
      profile.maxIterations = 0
      profile.toolRoundLimitConfigured = true
      migrated = true
    }
    if (migrated) this.save()
    this.selectedProfileId = this.settings.defaultProfileId === 'claude-code' ? 'claude-code' : this.profiles.find(profile => profile.id === this.settings.defaultProfileId)?.id || this.profiles[0]?.id || ''
    this.scheduleSubscription = this.schedules?.changes$.subscribe(data => this.zone.run(() => {
      if (this.destroyed) return
      this.scheduleData = data
      if (!data.tasks.some(task => task.id === this.scheduleDeleteId)) this.scheduleDeleteId = ''
      this.changeDetector?.markForCheck()
    }))
  }
  selectProfile (id: string): void {
    this.instructionGeneration++; this.instructionNotice = ''; this.instructionPreview = undefined; this.nativeNotice = ''; this.nativeCommand = ''
    this.memoryOpen = false
    this.schedulesOpen = false
    this.scheduleDeleteId = ''
    this.selectedProfileId = id
    this.draftNotice = ''
    this.providerSearch = ''
    this.draftErrors = []
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
    this.workflowAlias = workflow.alias || ''
    this.workflowTitle = workflow.title
    this.workflowObjective = workflow.objective
    this.workflowInstructions = workflowInstructions(workflow)
    this.workflowEnabled = workflow.enabled
    this.workflowPolicies = JSON.stringify(Object.fromEntries(workflow.steps.flatMap((step, i) => step.policy ? [[String(i + 1), step.policy]] : [])), null, 2)
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
    await this.changeMemory(() => this.memory!.library.saveWorkflow(workflow, this.workflowTitle, this.workflowObjective, this.workflowInstructions, this.workflowEnabled, this.workflowAlias, JSON.parse(this.workflowPolicies)), '流程已保存；后续自动归档会保留你的修改')
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
    if (id && id !== 'claude-code' && !this.persistedProfiles.some(p => p.id === id)) return
    this.settings.defaultProfileId = id
    this.save()
  }
  save (): void { void this.config.save().catch(() => this.zone.run(() => { this.notice = '保存配置失败，请检查配置目录' })) }
  setToolRoundLimit (profile: ApiProfile, value: number): void {
    profile.toolRoundLimitConfigured = true
    profile.maxIterations = value
    profile.maxIterations = normalizeApiProfile(profile).maxIterations
    this.draftChanged(profile)
  }
  addProfile (): void {
    const profile: ApiProfile = { id: agentId(), name: this.t('新的 API 连接'), runtime: 'pi',
      piConnection: { version: 1, mode: 'native', providerId: 'google' }, provider: 'custom', baseUrl: '',
      model: '', apiKeyEnv: 'GEMINI_API_KEY', useVault: false, keySource: 'direct', apiKey: '', thinking: 'default', reasoningEffort: '', contextWindow: 0,
      maxOutputTokens: 4096, maxIterations: 0, threads: {} }
    this.drafts.set(profile.id, profile)
    this.selectProfile(profile.id)
  }
  removeProfile (profile: ApiProfile): void {
    const index = this.profiles.findIndex(item => item.id === profile.id)
    this.testing.get(profile.id)?.abort()
    this.testing.delete(profile.id)
    this.clearModelList(profile)
    this.drafts.delete(profile.id)
    this.settings.apiProfiles = (this.settings.apiProfiles || []).filter(item => item.id !== profile.id)
    if (this.settings.defaultProfileId === profile.id) this.settings.defaultProfileId = ''
    if (this.selectedProfileId === profile.id) this.selectProfile(this.profiles[Math.min(index, this.profiles.length - 1)]?.id || '')
    delete this.connectionTests[profile.id]
    this.save()
  }
  changeProvider (profile: ApiProfile, provider: ApiProvider): void {
    this.rememberProvider(profile)
    if (this.restoreProvider(profile, 'legacy', provider)) return
    const customUrl = profile.baseUrl?.trim().replace(/\/+$/, '') !== PROVIDER_URLS[profile.provider] ? profile.baseUrl : ''
    profile.apiKey = ''
    profile.provider = provider
    profile.baseUrl = provider === 'custom' ? customUrl : PROVIDER_URLS[provider]
    profile.apiKeyEnv = PROVIDER_ENV[provider]
    profile.apiFormat = 'chat-completions'
    if (provider !== 'custom' && apiKeySource(profile) === 'none') profile.keySource = 'direct'
    profile.model = provider === 'custom' ? profile.model : provider === 'kimi' ? 'kimi-k3.1-pro' : provider === 'kimi-coding' ? 'kimi-for-coding' : provider === 'bailian-coding' ? 'qwen3.7-plus' : ''
    if (this.providerRegions[provider]) profile.maxOutputTokens = 32768
    profile.thinking = 'default'
    profile.reasoningEffort = ''
    this.modelConnectionChanged(profile)
  }
  changeApiFormat (profile: ApiProfile, format: ApiFormat): void {
    profile.apiFormat = format
    this.modelConnectionChanged(profile)
  }
  changeRuntime (profile: ApiProfile, runtime: 'api' | 'pi'): void {
    if (runtime === 'pi') profile.runtime = 'pi'
    else { delete profile.runtime; delete profile.piConnection; profile.baseUrl ||= PROVIDER_URLS[profile.provider] }
    this.modelConnectionChanged(profile)
  }
  keySource (profile: ApiProfile): ApiKeySource { return apiKeySource(profile) }
  endpointRegion (profile: ApiProfile): string {
    const presets = this.providerRegions[profile.provider]
    const baseUrl = (profile.baseUrl || '').trim().replace(/\/+$/, '')
    return baseUrl === presets?.china ? 'china' : baseUrl === presets?.international ? 'international' : 'custom'
  }
  changeEndpointRegion (profile: ApiProfile, region: string): void {
    const presets = this.providerRegions[profile.provider]
    if (!presets || region !== 'china' && region !== 'international') return
    profile.baseUrl = presets[region]
    this.modelConnectionChanged(profile)
  }
  changeKeySource (profile: ApiProfile, source: ApiKeySource): void {
    profile.keySource = source
    profile.useVault = false
    this.modelConnectionChanged(profile)
  }
  clearModelList (profile: ApiProfile): void {
    this.fetchingModels.get(profile.id)?.abort()
    this.fetchingModels.delete(profile.id)
    delete this.modelLists[profile.id]
  }
  modelConnectionChanged (profile: ApiProfile): void {
    this.clearModelList(profile)
    this.testing.get(profile.id)?.abort()
    this.testing.delete(profile.id)
    delete this.connectionTests[profile.id]
  }
  async fetchModels (profile: ApiProfile, refresh = false): Promise<void> {
    if (this.fetchingModels.has(profile.id) || (!refresh && this.modelLists[profile.id])) return
    const snapshot = JSON.parse(JSON.stringify(profile)) as ApiProfile
    const controller = new AbortController()
    this.fetchingModels.set(profile.id, controller)
    const update = (running: boolean, notice: string, models: CodexModel[] = []) => {
      if (this.destroyed || this.fetchingModels.get(profile.id) !== controller) return
      this.zone.run(() => { this.modelLists[profile.id] = { running, notice, models }; this.changeDetector?.detectChanges() })
    }
    update(true, '正在获取模型列表…')
    try {
      if (snapshot.piConnection) { update(false, 'SDK 1.4.0 bundled catalog; account access unverified. Manual IDs supported.', piModels(snapshot)); return }
      const models = await discoverApiModels(snapshot, () => this.secrets.read(snapshot), controller.signal)
      update(false, models.length ? `已获取 ${models.length} 个模型，可选择或手动输入模型 ID` : '服务端未返回可用模型，请手动填写模型 ID', models)
    } catch (error: any) { update(false, `获取模型列表失败：${error.message}`) }
    finally { if (this.fetchingModels.get(profile.id) === controller) this.fetchingModels.delete(profile.id) }
  }
  async testProfile (profile: ApiProfile): Promise<void> {
    if (this.testing.has(profile.id)) return
    const controller = new AbortController()
    const snapshot = JSON.parse(JSON.stringify(profile)) as ApiProfile
    this.testing.set(profile.id, controller)
    const update = (notice: string, running = true) => {
      if (this.destroyed || this.testing.get(profile.id) !== controller) return
      this.zone.run(() => { this.connectionTests[profile.id] = { running, notice }; this.changeDetector?.detectChanges() })
    }
    update('正在测试连接…')
    const timeout = setTimeout(() => controller.abort(), 60000)
    const started = Date.now()
    let chunks = 0
    try {
      Object.assign(snapshot, normalizeApiProfile(snapshot))
      if (!snapshot.model.trim()) throw new Error('请填写模型 ID')
      if (snapshot.piConnection) validatePiProfile(snapshot)
      else apiUrl(snapshot.baseUrl, apiPath(snapshot))
      if (snapshot.runtime === 'pi') {
        await probePiModel(snapshot, () => this.secrets.read(snapshot), controller.signal, () => {})
        update(`测试成功：${snapshot.model} · ${Date.now() - started} ms · SSE 响应完成`, false)
        return
      }
      const key = await withAbort(this.secrets.read(snapshot), controller.signal)
      const adapter = new ApiProviderAdapter(snapshot, key)
      await adapter.generate([adapter.user('Reply with OK only.')], 'This is a connection test. Reply briefly and do not call tools.', [], controller.signal,
        () => { chunks++; update(`已收到流式回复（${chunks} 个片段）…`) },
        progress => update(progress.phase === 'thinking' ? `连接已响应，模型正在思考（已接收 ${progress.receivedChars} 字符）…` : '连接已响应…'))
      update(`测试成功：${snapshot.model} · ${Date.now() - started} ms${chunks ? ` · 收到 ${chunks} 个正文流片段` : ' · SSE 响应完成'}`, false)
    } catch (error: any) { update(controller.signal.aborted ? '测试已取消或超时' : `测试失败：${error.message}`, false) }
    finally { clearTimeout(timeout); if (this.testing.get(profile.id) === controller) this.testing.delete(profile.id) }
  }
  cancelTest (profile: ApiProfile): void { this.testing.get(profile.id)?.abort() }
  ngOnDestroy (): void {
    this.destroyed = true
    this.nativeCheck?.abort()
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
