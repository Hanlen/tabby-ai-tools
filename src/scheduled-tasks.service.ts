import { Injectable, OnDestroy } from '@angular/core'
import { ConfigService, NotificationsService, PlatformService } from 'tabby-core'
import * as path from 'path'
import { BehaviorSubject, Subscription } from 'rxjs'
import { AgentBackendFactory } from './agent-backend.service'
import { AgentSettings } from './config'
import { ScheduleDocument, ScheduledTaskStore, scheduleId } from './scheduled-tasks'
import { ScheduledApproval, ScheduledWorkflowRunner } from './scheduled-workflow-runner'
import { TabbyTabToolsService } from './tab-tools'
import { redactMemory } from './task-memory'
import type { CodexModel } from './codex.service'
import type { TaskModelCheck } from './model-probe'

class ProbeBudgetExceeded extends Error {}

interface ModelChoice { profileId: string; model: string; reasoningEffort: string; reason: string; check?: TaskModelCheck }

@Injectable()
export class ScheduledTasksService implements OnDestroy {
  readonly changes$ = new BehaviorSubject<ScheduleDocument>({ version: 1, tasks: [], runs: [] })
  readonly approvals$ = new BehaviorSubject<ScheduledApproval | undefined>(undefined)
  error = ''
  private instance?: ScheduledTaskStore
  private owner = scheduleId()
  private timer?: ReturnType<typeof setInterval>
  private subscription?: Subscription
  private runner?: ScheduledWorkflowRunner
  private preflight?: { runId: string; controller: AbortController }
  private ticking = false
  private stopped = false
  private reportedError = ''
  private revision = ''

  constructor (private config: ConfigService, private platform: PlatformService, private agents: AgentBackendFactory, private tabs: TabbyTabToolsService, private notifications: NotificationsService) {
    agents.scheduler = this
  }
  get store (): ScheduledTaskStore {
    if (!this.instance) {
      const configPath = this.platform.getConfigPath()
      if (!configPath) throw new Error('无法定位配置目录，定时任务暂不可用')
      this.instance = new ScheduledTaskStore(path.join(path.dirname(configPath), 'tabby-agent-schedules'))
    }
    return this.instance
  }
  start (): void {
    if (this.subscription || this.stopped) return
    this.subscription = this.config.ready$.subscribe(() => {
      if (this.timer || this.stopped) return
      void this.tick()
      this.timer = setInterval(() => { void this.tick() }, 1000)
    })
    window.addEventListener('unload', this.stop)
  }
  async refresh (): Promise<void> {
    try {
      const revision = await this.store.revision()
      this.changes$.next(await this.store.read()); this.revision = revision
      this.error = ''; this.reportedError = ''
    }
    catch (error: any) { this.error = String(error.message); throw error }
  }
  async call (name: string, args: any, cwd: string, profileId: string, settings: AgentSettings, signal?: AbortSignal): Promise<any> {
    args = typeof args === 'string' ? JSON.parse(args) : args
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('定时任务工具参数必须是对象')
    if (args.modelCheck !== undefined) throw new Error('模型测试结果只能由插件实际测试生成')
    let result: any
    if (name === 'scheduled_task_models') result = await this.availableModels(args.profileId ?? profileId, settings)
    else if (name === 'scheduled_task_create') {
      const overriding = ['profileId', 'model', 'reasoningEffort', 'selectionReason'].some(key => args[key] !== undefined)
      if (overriding) {
        const choice = await this.checkedModelChoice(await this.modelChoice(args, profileId, settings), settings, signal)
        result = await this.store.create({ ...args, selectionReason: choice.reason, modelCheck: choice.check }, cwd, choice.profileId, { ...settings, model: choice.model, reasoningEffort: choice.reasoningEffort })
      } else result = await this.store.create(args, cwd, profileId, settings)
    }
    else if (name === 'scheduled_task_set_model') {
      const task = (await this.store.read()).tasks.find(t => t.id === args.taskId && t.cwd === cwd)
      if (!task) throw new Error('找不到当前目录的定时任务')
      const choice = await this.checkedModelChoice(await this.modelChoice(args, task.profileId, settings), settings, signal)
      result = { task: await this.store.setModel(task.id, cwd, choice), effective: '下次运行生效，已经开始的运行继续使用原模型；当前对话和全局默认模型保持不变' }
    }
    else if (name === 'scheduled_task_update') result = await this.store.setEnabled(args.taskId, cwd, args.enabled)
    else if (name === 'scheduled_task_list') result = (await this.store.read()).tasks.filter(t => t.cwd === cwd)
    else if (name === 'scheduled_task_runs') {
      const data = await this.store.read()
      if (!data.tasks.some(t => t.id === args.taskId && t.cwd === cwd)) throw new Error('找不到当前目录的定时任务')
      result = data.runs.filter(r => r.taskId === args.taskId).sort((a, b) => b.startedAt - a.startedAt).slice(0, 5).map(r => ({ ...r, entries: r.entries.slice(-12) }))
    } else throw new Error('此工具仅可在定时任务执行期间使用')
    // The mutation is already durable; a view refresh failure must not invite duplicate creation.
    await this.refresh().catch(() => undefined)
    return { result, now: new Date().toISOString(), localTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...(name === 'scheduled_task_create' ? { nextRunAt: new Date(result.nextRunAt).toISOString(), note: '已保存，Tabby 重启后自动加载。仅在 Tabby 打开时执行；关闭期间错过的触发合并为一次。无人值守运行不询问，保留创建时的沙箱范围；遇到交互时先查找并自动选择最优答案，仍无法判断或需要额外授权时停止留档。可在 AI Tools 设置的定时任务中删除。' } : {}) }
  }
  private async availableModels (profileId: string, settings: AgentSettings) {
    const connections = this.agents.modelConnections()
    const connection = connections.find(c => c.profileId === profileId)
    if (!connection) throw new Error('找不到所选模型连接，请从当前配置的连接中选择')
    const backend = this.agents.create(profileId, true)
    let models: CodexModel[] = [], discoveryError = ''
    try {
      if (!backend.profile) await backend.connect({ ...settings, executable: this.config.store.codexAgent.executable ?? settings.executable, model: connection.model, reasoningEffort: connection.reasoningEffort })
      models = await backend.listModels()
    } catch (error: any) { discoveryError = redactMemory(String(error.message || error), 1000) }
    finally { backend.client.close() }
    const listedModels = models.map(model => ({ model: model.model, displayName: model.displayName, description: model.description || '', isDefault: !!model.isDefault,
      defaultReasoningEffort: model.defaultReasoningEffort || '', supportedReasoningEfforts: model.supportedReasoningEfforts || [] }))
    return { connections, profileId, models: listedModels, configuredModel: connection.model, discoveryError,
      notice: '模型列表用于确认候选 ID，不提供可靠的能力排名、价格或延迟；未发送推理请求，工具调用能力和实际效果需在执行中验证。列表不可用时仍可选择该连接已经配置的模型。' }
  }
  private async modelChoice (args: any, fallbackProfileId: string, settings: AgentSettings) {
    const profileId = args.profileId ?? fallbackProfileId
    const connection = this.agents.modelConnections().find(c => c.profileId === profileId)
    if (!connection) throw new Error('找不到所选模型连接，请从当前配置的连接中选择')
    const model = args.model ?? connection.model
    const reasoningEffort = args.reasoningEffort ?? connection.reasoningEffort
    const reason = args.reason ?? args.selectionReason
    if (typeof model !== 'string' || model.length > 200 || !model.trim() && profileId || typeof reasoningEffort !== 'string' || reasoningEffort.length > 64 || typeof reason !== 'string' || !reason.trim() || reason.length > 1000 || redactMemory(model, 200) !== model) throw new Error('请选择有效模型，并说明与任务需求相关的选择理由')
    if (model !== connection.model) {
      const available = await this.availableModels(profileId, settings)
      const selected = available.models.find(item => item.model === model)
      if (!selected) throw new Error('模型未出现在当前连接的可用列表中，不能凭空填写模型 ID')
      if (reasoningEffort && selected.supportedReasoningEfforts.length && !selected.supportedReasoningEfforts.some(item => item.reasoningEffort === reasoningEffort)) throw new Error('所选模型不支持该推理强度')
    }
    return { profileId, model: model.trim(), reasoningEffort: reasoningEffort.trim(), reason }
  }
  private defaultModelChoice (): ModelChoice {
    const connection = this.agents.modelConnections().find(c => c.profileId === this.agents.defaultProfileId)
    if (!connection) throw new Error('插件默认模型连接已移除，无法回退')
    return { profileId: connection.profileId, model: connection.model, reasoningEffort: connection.reasoningEffort, reason: '使用插件默认模型' }
  }
  private async checkedModelChoice (choice: ModelChoice, settings: AgentSettings, signal?: AbortSignal, status: (text: string) => Promise<void> = async () => {}, usage: (tokens: number) => Promise<void> = async () => {}, budget = 0): Promise<ModelChoice> {
    let totalTokens = 0
    const failure = (message: string) => Object.assign(new Error(`${message}；模型测试累计 ${totalTokens} tokens`), { totalTokens })
    const probe = async (selection: ModelChoice) => {
      let result
      try { result = await this.agents.probeModel(selection.profileId, { ...settings, model: selection.model, reasoningEffort: selection.reasoningEffort }, signal) }
      catch (error: any) {
        totalTokens += Number.isFinite(error.totalTokens) && error.totalTokens > 0 ? error.totalTokens : 0
        await usage(totalTokens)
        await status(`模型测试中断：${selection.model || 'Codex 默认'}；已上报累计 ${totalTokens} tokens`)
        throw Object.assign(error, { totalTokens })
      }
      totalTokens += result.totalTokens
      await usage(totalTokens)
      await status(`模型测试用量：${selection.model || 'Codex 默认'} ${result.totalTokens} tokens；累计 ${totalTokens} tokens；${result.ok ? '通过' : '失败'}`)
      if (budget > 0 && totalTokens >= budget) throw new ProbeBudgetExceeded('模型测试用量已达到本次运行 token 预算，未启动任务操作')
      return result
    }
    await status(`正在测试候选模型：${choice.model || 'Codex 默认'} · ${choice.reasoningEffort || '默认推理强度'}`)
    const candidate = await probe(choice)
    if (signal?.aborted) throw new Error('模型测试已取消')
    let selected = choice, verified = candidate
    if (!candidate.ok) {
      await status(`候选模型测试失败：${candidate.error || '未知错误'}`)
      try { selected = this.defaultModelChoice() } catch (error: any) { throw failure(`候选模型测试失败：${candidate.error || '未知错误'}；${error.message}`) }
      await status(`回退到插件默认模型：${selected.model || 'Codex 默认'}`)
      if (selected.profileId === choice.profileId && selected.model === choice.model && selected.reasoningEffort === choice.reasoningEffort) throw failure(`默认模型测试失败：${candidate.error || '未知错误'}；没有其他默认模型可回退`)
      verified = await probe(selected)
      if (signal?.aborted) throw new Error('模型测试已取消')
      if (!verified.ok) throw failure(`候选模型测试失败：${candidate.error || '未知错误'}；默认模型也未通过测试：${verified.error || '未知错误'}`)
      selected = { ...selected, reason: redactMemory(`${choice.model || 'Codex 默认'}（${choice.reasoningEffort || '默认'}）测试失败：${candidate.error || '未知错误'}；回退到插件默认模型。原选模说明：${choice.reason}`, 1000) }
    }
    const check: TaskModelCheck = { requestedProfileId: choice.profileId, requestedModel: choice.model, requestedReasoningEffort: choice.reasoningEffort,
      selectedProfileId: selected.profileId, selectedModel: selected.model, selectedReasoningEffort: selected.reasoningEffort, testedAt: Date.now(),
      fallbackUsed: !candidate.ok, totalTokens, ...(candidate.ok ? {} : { candidateError: redactMemory(candidate.error || '未知错误', 1000) }) }
    await status(`模型测试通过：${selected.model || 'Codex 默认'}；${check.fallbackUsed ? '已使用默认模型' : '候选模型已可用'}`)
    return { ...selected, check }
  }
  async setEnabled (taskId: string, cwd: string, enabled: boolean): Promise<void> {
    await this.store.setEnabled(taskId, cwd, enabled)
    await this.refresh().catch(() => undefined)
  }
  async remove (taskId: string, cwd: string): Promise<void> {
    await this.store.remove(taskId, cwd)
    await this.refresh().catch(() => undefined)
  }
  async runNow (taskId: string, cwd: string): Promise<void> {
    if (this.runner || this.preflight || this.ticking) throw new Error('已有定时任务运行中，请稍后再试')
    this.ticking = true
    try {
      const claim = await this.store.claim(this.owner, Date.now(), taskId, cwd)
      if (!claim) throw new Error('其他窗口已有定时任务运行中')
      this.launch(claim)
      await this.refresh().catch(() => undefined)
    } finally { this.ticking = false }
  }
  stopRun (runId: string): void {
    if (this.runner?.run.id === runId) this.runner.stop()
    else if (this.preflight?.runId === runId) this.preflight.controller.abort()
    else throw new Error('本次运行由其他窗口管理，请在对应窗口停止')
  }
  private async tick (): Promise<void> {
    if (this.stopped || this.ticking) return
    this.ticking = true
    try {
      // Poll only file metadata while idle; execution logs can grow to 24 MiB.
      if (await this.store.revision() !== this.revision) await this.refresh()
      if (!this.runner && !this.preflight) {
        const data = this.changes$.value
        if (data.tasks.some(t => t.enabled && t.nextRunAt !== null && t.nextRunAt <= Date.now()) || data.runs.some(r => ['running', 'waiting_approval'].includes(r.status) && r.leaseUntil <= Date.now())) {
          const claim = await this.store.claim(this.owner)
          if (claim) this.launch(claim)
          await this.refresh()
        }
      }
    } catch (error: any) {
      this.error = String(error.message)
      if (this.reportedError !== this.error) { this.reportedError = this.error; this.notifications.error('定时任务失败', this.error) }
    } finally { this.ticking = false }
  }
  private launch (claim: NonNullable<Awaited<ReturnType<ScheduledTaskStore['claim']>>>): void {
    const execute = async () => {
      const controller = new AbortController()
      this.preflight = { runId: claim.run.id, controller }
      const heartbeat = setInterval(() => { void this.store.mutateRun(claim.run.id, this.owner, () => {}).catch(() => controller.abort()) }, 10000)
      try {
        // CLI location is runtime infrastructure; retain the task's model and permissions.
        let task = { ...claim.task, settings: { ...claim.task.settings, executable: this.config.store.codexAgent.executable ?? claim.task.settings.executable } }
        const previousFallback = task.modelCheck?.fallbackUsed ? task.modelCheck : undefined
        const preferred: ModelChoice = previousFallback
          ? { profileId: previousFallback.requestedProfileId, model: previousFallback.requestedModel, reasoningEffort: previousFallback.requestedReasoningEffort, reason: `重新验证任务首选模型。此前选模说明：${task.modelSelectionReason || ''}` }
          : { profileId: task.profileId, model: task.settings.model, reasoningEffort: task.settings.reasoningEffort, reason: task.modelSelectionReason || '沿用任务保存的模型' }
        const defaults = this.agents.modelConnections().find(c => c.profileId === this.agents.defaultProfileId)
        if (task.modelSelectionReason || !defaults || preferred.profileId !== defaults.profileId || preferred.model !== defaults.model || preferred.reasoningEffort !== defaults.reasoningEffort) {
          await this.store.mutateRun(claim.run.id, this.owner, run => { delete run.modelCheck; run.summary = '正在测试任务模型，尚未开始任务操作' })
          const choice = await this.checkedModelChoice(preferred,
            task.settings, controller.signal, text => this.store.append(claim.run.id, this.owner, 'status', text), async tokens => {
              claim.run.probeTokens = tokens
              await this.store.mutateRun(claim.run.id, this.owner, run => { run.probeTokens = tokens; run.totalTokens = tokens })
            }, task.settings.goalTokenBudget)
          task = { ...task, profileId: choice.profileId, settings: { ...task.settings, model: choice.model, reasoningEffort: choice.reasoningEffort }, modelSelectionReason: choice.reason, modelCheck: choice.check }
          claim.run.probeTokens = choice.check?.totalTokens || 0
          await this.store.mutateRun(claim.run.id, this.owner, run => {
            run.profileId = task.profileId; run.model = task.settings.model; run.reasoningEffort = task.settings.reasoningEffort
            run.modelSelectionReason = task.modelSelectionReason; run.modelCheck = choice.check; run.probeTokens = claim.run.probeTokens
            run.totalTokens = claim.run.probeTokens
            run.summary = ''
          })
        }
        if (controller.signal.aborted) throw new Error('模型测试已取消')
        const backend = this.agents.create(task.profileId, true)
        if (backend.profile) Object.assign(backend.profile, { model: task.settings.model, reasoningEffort: task.settings.reasoningEffort })
        this.runner = new ScheduledWorkflowRunner(this.store, task, claim.run, backend, {
          decisionBackend: () => {
            const decision = this.agents.create(task.profileId, true)
            if (decision.profile) Object.assign(decision.profile, { model: task.settings.model, reasoningEffort: task.settings.reasoningEffort })
            return decision
          },
          call: (name, args, context) => this.tabs.call(name, args, context), release: owner => this.tabs.releaseOwner(owner),
          close: () => backend.client.close(),
          approval: approval => this.approvals$.next(approval),
        })
        this.preflight = undefined
        clearInterval(heartbeat)
        if (this.stopped) this.runner.stop('应用正在退出，本次任务已中断。')
        await this.runner.execute()
      } catch (error: any) {
        await this.store.mutateRun(claim.run.id, this.owner, (run, task) => { run.status = controller.signal.aborted ? 'interrupted' : error instanceof ProbeBudgetExceeded ? 'needs_attention' : 'failed'; run.summary = String(error.message); run.finishedAt = Date.now(); task.enabled = false }).catch(() => undefined)
        if (!controller.signal.aborted) this.notifications.error('定时任务执行失败', String(error.message))
      } finally {
        clearInterval(heartbeat)
        this.preflight = undefined
        this.runner = undefined
        this.approvals$.next(undefined)
        await this.refresh().catch(() => undefined)
      }
    }
    void execute()
  }
  private readonly stop = (): void => {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.subscription?.unsubscribe()
    this.preflight?.controller.abort()
    this.runner?.stop('应用退出，本次任务已中断；终端操作结果需要核对。')
    window.removeEventListener('unload', this.stop)
  }
  ngOnDestroy (): void { this.stop() }
}
