import { promises as fs } from 'fs'
import * as path from 'path'
import { randomBytes } from 'crypto'
import type { AgentSettings } from './config'
import { redactMemory } from './task-memory'
import type { TaskModelCheck } from './model-probe'

export type TaskSchedule = { type: 'at'; at: number } | { type: 'interval'; minutes: number } | { type: 'daily'; time: string; timezone: string }
export interface ScheduledTask {
  id: string; title: string; instructions: string; cwd: string; profileId: string; settings: AgentSettings
  schedule: TaskSchedule; enabled: boolean; createdAt: number; nextRunAt: number | null; lastRunId?: string
  modelSelectionReason?: string; modelUpdatedAt?: number
  modelCheck?: TaskModelCheck
}
export type RunStatus = 'running' | 'waiting_approval' | 'completed' | 'failed' | 'interrupted' | 'needs_attention'
export interface RunEntry { at: number; kind: 'action' | 'output' | 'assistant' | 'status'; text: string }
export interface ScheduledRun {
  id: string; taskId: string; scheduledAt: number; startedAt: number; finishedAt?: number; status: RunStatus
  owner: string; leaseUntil: number; threadId?: string; turnId?: string; totalTokens?: number; summary: string; entries: RunEntry[]
  profileId?: string; model?: string; reasoningEffort?: string; modelSelectionReason?: string
  modelCheck?: TaskModelCheck; probeTokens?: number
}
export interface ScheduleDocument { version: 1; tasks: ScheduledTask[]; runs: ScheduledRun[] }
export const scheduleId = (): string => randomBytes(12).toString('hex')
export const activeRun = (run: ScheduledRun): boolean => run.status === 'running' || run.status === 'waiting_approval'

export function parseSchedule (args: any, now: number): TaskSchedule {
  if (args.scheduleType === 'at') {
    const at = typeof args.at === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(args.at) ? Date.parse(args.at) : NaN
    if (!Number.isFinite(at) || at <= now) throw new Error('单次任务需要未来的 ISO 时间，并带 Z 或 UTC 偏移')
    return { type: 'at', at }
  }
  if (args.scheduleType === 'interval' && Number.isInteger(args.intervalMinutes) && args.intervalMinutes >= 1 && args.intervalMinutes <= 525600) return { type: 'interval', minutes: args.intervalMinutes }
  if (args.scheduleType === 'daily' && typeof args.time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(args.time) && typeof args.timezone === 'string' && args.timezone) {
    new Intl.DateTimeFormat('en', { timeZone: args.timezone }).format(now)
    return { type: 'daily', time: args.time, timezone: args.timezone }
  }
  throw new Error('定时规则无效：需要 at、interval 或带时区的 daily')
}

export function nextOccurrence (schedule: TaskSchedule, after: number, anchor = after): number | null {
  if (schedule.type === 'at') return schedule.at > after ? schedule.at : null
  if (schedule.type === 'interval') {
    const period = schedule.minutes * 60000
    return anchor + (Math.floor((after - anchor) / period) + 1) * period
  }
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: schedule.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: schedule.timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
  const skipDay = formatter.format(after) >= schedule.time ? dayFormatter.format(after) : ''
  // Search real instants so daylight-saving gaps are skipped and offsets remain correct.
  for (let time = Math.floor(after / 60000) * 60000 + 60000; time <= after + 49 * 3600000; time += 60000) {
    if (formatter.format(time) === schedule.time && dayFormatter.format(time) !== skipDay) return time
  }
  throw new Error('无法计算下一次执行时间')
}

function validDocument (data: any): data is ScheduleDocument {
  const number = (n: any) => Number.isFinite(n) && n >= 0
  const string = (s: any) => typeof s === 'string'
  const check = (c: any) => c === undefined || c && ['requestedProfileId', 'requestedModel', 'requestedReasoningEffort', 'selectedProfileId', 'selectedModel', 'selectedReasoningEffort'].every(k => string(c[k])) && typeof c.fallbackUsed === 'boolean' && number(c.testedAt) && number(c.totalTokens) && (c.candidateError === undefined || string(c.candidateError))
  return data?.version === 1 && Array.isArray(data.tasks) && data.tasks.length <= 100 && Array.isArray(data.runs) && data.runs.length <= 200 &&
    data.tasks.every((t: any) => t && ['id', 'title', 'instructions', 'cwd', 'profileId'].every(k => string(t[k])) && typeof t.enabled === 'boolean' && number(t.createdAt) && (t.nextRunAt === null || number(t.nextRunAt)) &&
      t.settings && ['on-request', 'never', 'untrusted'].includes(t.settings.approvalPolicy) && ['read-only', 'workspace-write', 'danger-full-access'].includes(t.settings.sandbox) && string(t.settings.model) && string(t.settings.executable) &&
      (t.modelSelectionReason === undefined || string(t.modelSelectionReason)) && (t.modelUpdatedAt === undefined || number(t.modelUpdatedAt)) &&
      check(t.modelCheck) &&
      (t.schedule?.type === 'at' && number(t.schedule.at) || t.schedule?.type === 'interval' && Number.isInteger(t.schedule.minutes) && t.schedule.minutes >= 1 && t.schedule.minutes <= 525600 ||
        t.schedule?.type === 'daily' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t.schedule.time) && string(t.schedule.timezone) && (() => { try { new Intl.DateTimeFormat('en', { timeZone: t.schedule.timezone }); return true } catch { return false } })())) &&
    data.runs.every((r: any) => r && ['id', 'taskId', 'owner', 'summary'].every(k => string(r[k])) && ['running', 'waiting_approval', 'completed', 'failed', 'interrupted', 'needs_attention'].includes(r.status) &&
      [r.scheduledAt, r.startedAt, r.leaseUntil].every(number) && (r.probeTokens === undefined || number(r.probeTokens)) && check(r.modelCheck) && ['profileId', 'model', 'reasoningEffort', 'modelSelectionReason'].every(k => r[k] === undefined || string(r[k])) && Array.isArray(r.entries) && r.entries.length <= 500 && r.entries.every((e: any) => e && number(e.at) && ['action', 'output', 'assistant', 'status'].includes(e.kind) && string(e.text)))
}

/** Shared atomic state and occurrence claims protect against duplicate execution in multiple windows. */
export class ScheduledTaskStore {
  private writes: Promise<unknown> = Promise.resolve()
  readonly file: string
  constructor (private root: string) { this.file = path.join(root, 'scheduled-tasks.json') }
  async revision (): Promise<string> {
    try { const stat = await fs.stat(this.file); return `${stat.ino}:${stat.mtimeMs}:${stat.size}` }
    catch (error: any) { if (error.code === 'ENOENT') return 'missing'; throw error }
  }
  async read (): Promise<ScheduleDocument> {
    try {
      if ((await fs.stat(this.file)).size > 24 * 1024 * 1024) throw new Error('定时任务库过大')
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'))
      if (!validDocument(data)) throw new Error('定时任务库格式损坏，请检查 scheduled-tasks.json')
      return data
    } catch (error: any) { if (error.code === 'ENOENT') return { version: 1, tasks: [], runs: [] }; throw error }
  }
  update<T> (change: (data: ScheduleDocument) => T): Promise<T> {
    const operation = this.writes.catch(() => undefined).then(async () => {
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 })
      const lockPath = this.file + '.lock'
      let lock: Awaited<ReturnType<typeof fs.open>> | undefined
      for (let attempt = 0; attempt < 100; attempt++) {
        try { lock = await fs.open(lockPath, 'wx', 0o600); break } catch (error: any) {
          if (error.code !== 'EEXIST') throw error
          const stat = await fs.stat(lockPath).catch(() => undefined)
          if (stat && Date.now() - stat.mtimeMs > 60000) await fs.unlink(lockPath).catch(() => undefined)
          else await new Promise(resolve => setTimeout(resolve, 20))
        }
      }
      if (!lock) throw new Error('定时任务库正被其他窗口更新')
      const temporary = this.file + '.' + scheduleId() + '.tmp'
      try {
        const data = await this.read()
        const result = change(data)
        // Keep recent records without discarding an executing run.
        data.runs = [...data.runs.filter(activeRun), ...data.runs.filter(r => !activeRun(r)).sort((a, b) => b.startedAt - a.startedAt).slice(0, 200 - data.runs.filter(activeRun).length)]
        let serialized = JSON.stringify(data)
        while (Buffer.byteLength(serialized) > 24 * 1024 * 1024) {
          let oldest = -1
          for (let i = data.runs.length - 1; i >= 0; i--) if (!activeRun(data.runs[i])) { oldest = i; break }
          if (oldest < 0) break
          data.runs.splice(oldest, 1)
          serialized = JSON.stringify(data)
        }
        if (!validDocument(data) || Buffer.byteLength(serialized) > 24 * 1024 * 1024) throw new Error('定时任务库已满或内容无效')
        await fs.writeFile(temporary, serialized, { mode: 0o600, flag: 'wx' })
        // Windows readers/indexers can briefly deny replacement. Keep the old
        // file and the lock intact while retrying the same serialized update.
        for (let attempt = 0; ; attempt++) {
          try { await fs.rename(temporary, this.file); break } catch (error: any) {
            if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 8) throw error
            await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)))
          }
        }
        return result
      } finally {
        await fs.unlink(temporary).catch(() => undefined)
        await lock.close()
        await fs.unlink(lockPath).catch(() => undefined)
      }
    })
    this.writes = operation.catch(() => undefined)
    return operation
  }
  async create (args: any, cwd: string, profileId: string, settings: AgentSettings, now = Date.now()): Promise<ScheduledTask> {
    if (!args || typeof args.title !== 'string' || !args.title.trim() || args.title.length > 120 || typeof args.instructions !== 'string' || !args.instructions.trim() || args.instructions.length > 10000 || !cwd) throw new Error('需要任务名称、完整执行要求和工作目录')
    if (redactMemory(args.instructions, 10000) !== args.instructions) throw new Error('任务要求含凭据或控制字符，请改用环境变量或凭据引用')
    const schedule = parseSchedule(args, now)
    // Never copy API keys, connection profiles or foreground conversation IDs into the task file.
    const snapshot: AgentSettings = { executable: settings.executable || 'codex', cwd, model: settings.model || '', reasoningEffort: settings.reasoningEffort || '',
      approvalPolicy: settings.approvalPolicy, sandbox: settings.sandbox, goalTokenBudget: settings.goalTokenBudget || 0, threads: {}, tabToolThreads: {}, tabToolVersions: {} }
    const task: ScheduledTask = { id: scheduleId(), title: redactMemory(args.title, 120), instructions: args.instructions.trim(), cwd, profileId, settings: snapshot, schedule, enabled: true, createdAt: now, nextRunAt: nextOccurrence(schedule, now) }
    if (typeof args.selectionReason === 'string' && args.selectionReason.trim()) { task.modelSelectionReason = redactMemory(args.selectionReason.trim(), 1000); task.modelUpdatedAt = now }
    if (args.modelCheck) task.modelCheck = args.modelCheck
    return this.update(data => { if (data.tasks.length >= 100) throw new Error('最多保存 100 个定时任务'); data.tasks.push(task); return task })
  }
  setEnabled (taskId: string, cwd: string, enabled: boolean, now = Date.now()): Promise<ScheduledTask> {
    return this.update(data => {
      const task = data.tasks.find(t => t.id === taskId && t.cwd === cwd)
      if (!task || typeof enabled !== 'boolean') throw new Error('找不到当前目录的任务或参数无效')
      if (enabled && !task.enabled) {
        task.nextRunAt = nextOccurrence(task.schedule, now, task.createdAt)
        if (task.nextRunAt === null) throw new Error('单次任务时间已过，请创建新任务或点击立即运行')
      }
      task.enabled = enabled
      return task
    })
  }
  remove (taskId: string, cwd: string): Promise<void> {
    return this.update(data => {
      if (!data.tasks.some(t => t.id === taskId && t.cwd === cwd)) throw new Error('找不到当前目录的定时任务')
      // Check under the same file lock as claim(), including claims by another window.
      if (data.runs.some(r => r.taskId === taskId && activeRun(r))) throw new Error('任务仍在运行，请先停止本次运行，等待结束后再删除')
      data.tasks = data.tasks.filter(t => t.id !== taskId)
      data.runs = data.runs.filter(r => r.taskId !== taskId)
    })
  }
  setModel (taskId: string, cwd: string, choice: { profileId: string; model: string; reasoningEffort: string; reason: string; check?: TaskModelCheck }): Promise<ScheduledTask> {
    if (!choice || ['profileId', 'model', 'reasoningEffort', 'reason'].some(key => typeof (choice as any)[key] !== 'string') || !choice.reason.trim() || choice.model.length > 200 || choice.reasoningEffort.length > 64 || choice.reason.length > 1000) return Promise.reject(new Error('模型选择需要有效的连接、模型、推理强度和选择理由'))
    return this.update(data => {
      const task = data.tasks.find(t => t.id === taskId && t.cwd === cwd)
      if (!task) throw new Error('找不到当前目录的定时任务')
      task.profileId = choice.profileId; task.settings.model = choice.model; task.settings.reasoningEffort = choice.reasoningEffort
      task.modelSelectionReason = redactMemory(choice.reason.trim(), 1000); task.modelUpdatedAt = Date.now()
      task.modelCheck = choice.check
      return task
    })
  }
  claim (owner: string, now = Date.now(), taskId?: string, cwd?: string): Promise<{ task: ScheduledTask; run: ScheduledRun } | undefined> {
    return this.update(data => {
      for (const run of data.runs) if (activeRun(run) && run.leaseUntil <= now) {
        run.status = 'interrupted'; run.finishedAt = now; run.summary = '运行进程退出或租约失效；操作结果可能未知，未自动重放。请检查后恢复任务。'
        const task = data.tasks.find(t => t.id === run.taskId)
        if (task) task.enabled = false
      }
      if (data.runs.some(activeRun)) return undefined
      const task = data.tasks.filter(t => taskId ? t.id === taskId && t.cwd === cwd : t.enabled && t.nextRunAt !== null && t.nextRunAt <= now).sort((a, b) => (a.nextRunAt || 0) - (b.nextRunAt || 0))[0]
      if (!task) { if (taskId) throw new Error('找不到当前目录的定时任务'); return undefined }
      const run: ScheduledRun = { id: scheduleId(), taskId: task.id, scheduledAt: taskId ? now : task.nextRunAt!, startedAt: now, status: 'running', owner, leaseUntil: now + 60000, summary: '', entries: [], profileId: task.profileId, model: task.settings.model, reasoningEffort: task.settings.reasoningEffort || '', modelSelectionReason: task.modelSelectionReason || '沿用创建任务时的模型' }
      if (task.modelCheck) run.modelCheck = task.modelCheck
      if (!taskId) { task.nextRunAt = nextOccurrence(task.schedule, now, task.createdAt); if (task.nextRunAt === null) task.enabled = false }
      task.lastRunId = run.id
      data.runs.unshift(run)
      return { task, run }
    })
  }
  mutateRun (runId: string, owner: string, change: (run: ScheduledRun, task: ScheduledTask) => void): Promise<void> {
    return this.update(data => {
      const run = data.runs.find(r => r.id === runId && r.owner === owner && activeRun(r))
      const task = run && data.tasks.find(t => t.id === run.taskId)
      if (!run || !task || run.leaseUntil <= Date.now()) throw new Error('运行租约已失效，已停止执行')
      change(run, task)
      run.summary = redactMemory(run.summary, 10000)
      run.leaseUntil = Date.now() + 60000
    })
  }
  append (runId: string, owner: string, kind: RunEntry['kind'], text: string): Promise<void> {
    return this.mutateRun(runId, owner, run => {
      if (run.entries.length >= 499) throw new Error('执行记录已达上限，停止后续操作')
      run.entries.push({ at: Date.now(), kind, text: redactMemory(text, 12000) + (text.length > 12000 ? '\n[记录超过 12,000 字符，已截断]' : '') })
    })
  }
}
