import { promises as fs } from 'fs'
import * as path from 'path'
import { randomBytes } from 'crypto'
import { isIP } from 'net'
import { WorkflowPolicy, WorkflowObservation, WorkflowQuestion, validPolicy, matchesConditions } from './workflow-policy'
import type { UserQuestion } from './user-input'
import { createHash } from 'crypto'
import { TERMINAL_INPUT_MAX_LENGTH } from './terminal-limits'

export interface WorkflowTarget {
  type: string; profileId: string; serverId: string; host: string; ip: string; port: number; username: string; cwd: string
}
export interface StepVerification { criteria: string; evidence: string; confirmedAt: number }
export interface TaskStep {
  id?: string; policy?: WorkflowPolicy; skipped?: boolean
  purpose: string; command: string; target: string; server?: WorkflowTarget
  dependsOn?: number[]; verification?: StepVerification; verificationCommands?: string[]
}
export interface TaskWorkflow {
  questions?: WorkflowQuestion[]
  id: string; alias?: string; title: string; objective: string; cwd: string; steps: TaskStep[]; instructions: string
  outcome: string; completedAt: number; successes: number; uses: number; enabled: boolean; edited: boolean
}
export interface TaskPreference { id: string; text: string; cwd: string }
export interface MemoryDocument { version: 1 | 2; workflows: TaskWorkflow[]; preferences: TaskPreference[] }
export interface MemorySuggestion { workflow?: TaskWorkflow; preferences: TaskPreference[]; context: string }
interface TaskRun {
  token: string; cwd: string; objective: string; steps: TaskStep[]; reads: number; verifiedSteps: number
  targets: Record<string, { title: string; server?: WorkflowTarget; bound?: boolean }>; stepTabs: string[]; observations: Record<string, { serial: number; running: boolean; fingerprint: string; value: WorkflowObservation }>
  serial: number; lastCommand: number; inFlight: boolean; capture: boolean; expected?: TaskStep[]; truncated: boolean; archiveIssue?: string; finishing: boolean
  interactionReads?: Record<string, number>; interactionReceipts?: Record<string, string>; runnerBusy?: boolean; helperTokens?: number; helperCalls?: Record<string, number>
  uncertain?: { tool: string; step: number; command?: string; purpose?: string }; restored?: boolean
  questions?: WorkflowQuestion[]
}
interface CompletedRecording { run: TaskRun; outcome: string; workflowId?: string; error?: string; saving?: Promise<TaskWorkflow> }
export interface WorkflowRuntimeState {
  objective: string; capture: boolean; number: number; pending?: TaskStep; pendingTab?: string; expected?: TaskStep
  complete: boolean; observation?: TaskRun['observations'][string]; helperTokens: number
  uncertain?: TaskRun['uncertain']; restored: boolean
}

export const WORKFLOW_HINT = `任务流程执行协议：
固定操作尽量脚本化：同一逻辑步骤可提交完整多行脚本（最多 10000 字符，不截断），独立执行验证命令并用 workflow_configure 保存 verify/expect，交由运行器自动推进。需 AI 判断的步骤设置 policy.decision 为具体决策意图：运行器在执行前返回 needs_model，主模型读取当前现场后决定并用 send_input 提交该逻辑步骤，再继续 workflow_run；不得重发前序操作。跨服务器、依赖验收和必要决策仍拆成独立步骤。
交互也应固化：stdin、按键、接管进程会录制为步骤内交互节点，不保存原始回答或按键历史。用 workflow_configure 为已观察步骤保存 policy：when 条件为真执行、否则跳过；verify 是独立验证命令与结果条件；interactions 保存目标意图、明确条件下的回答规则及 model/manual 兜底。未走过的规则标记 observed=false，不声称已验证。不能仅由一次回答推导普遍规则。每次交互后必须重新读取同一终端；发出回答不等于该步骤完成。敏感交互保存 manual 节点，不保存凭据。
执行别名时优先 workflow_run(tabId)：运行器推进该目标的已保存条件、命令、交互规则和验收，未知交互调用当前连接的辅助模型；返回 needs_model/needs_attention/awaiting_verification 时从当前节点处理，不重放已经提交的命令。跨服务器返回需要绑定的下一目标，重新核对后继续 workflow_run。无可靠完成状态或机器验收规则时仍由主模型现场验收。workflow_interact 可处理当前未验收步骤的交互；相同观察不能重复回答。辅助调用计入本次目标预算。
checkpoint 成功仅表示目标绑定或步骤验收，不代表流程已归档。先用 workflow_status 查询录制模式、归档资格和失败原因；用户要求设置别名时，核对最近录制的 objective，再用 workflow_set_alias 保存，并以 saved=true 和回读别名确认。未录制的普通任务不能事后归档；明确说明限制和 /remember 后续路径，不反复检查设置或重跑已完成操作。
流程中的步骤数组和 dependsOn 是执行顺序，不得跨服务器并行抢跑。开始前用 list_tabs/read_tab/get_profile 重新绑定实际终端；profileId/serverId 是持久身份，临时 tab ID 不能存为服务器 ID。核对服务器 host/IP、SSH 端口、账户与操作路径，主机名不能冒充已知 IP；拿不到的字段要通过当前终端的可信检查确认，禁止猜测。profile 信息不能证明嵌套 SSH、容器或跳板后的实际目标。
步骤之间的身份/路径探测命令使用 send_input(verificationFor=0)，再 read_tab，随后 workflow_checkpoint(action=bind_target,tabId,target,evidence) 绑定已观测身份。target.cwd 是该操作实际路径；cd、容器或嵌套 SSH 改变环境后重新核对绑定。
所有流程 Shell 操作使用 tabby_tabs.send_input，不改用本机 commandExecution。每个操作先确定验收条件，只提交一个逻辑步骤；跨服务器依赖必须拆开，不把依赖步骤塞进同一批并行工具或 Shell 脚本。提交操作后 read_tab 读取同一终端的新结果；需要检查命令时 send_input(verificationFor=当前步骤号)，检查命令仅验证该步骤且在同一服务器执行，再 read_tab。读到输出、工具返回 sent、没有子进程、超时或旧成功文本都不等于完成。
结果符合验收条件并确认命令结束后，调用 workflow_checkpoint(action=confirm_step,step=从1开始的步骤号,tabId,criteria,evidence)。evidence 只能简述本次实际观察的退出状态、健康检查或产物，不含凭据和原始日志。插件确认后才能执行下一步；失败、证据不足、目标或路径不符时停止后续依赖，先诊断或请用户补充。这里的确认由模型根据工具证据完成，只有额外授权或必要决策才询问用户。
终端输出不会自动追加到运行中的回合，必须用 read_tab 主动读取。限流、重试、中断或恢复后，先读取 pendingStep 的实际终端，检查产物、当前目录与 Git 状态，再验收已完成步骤并继续。模型等待不代表终端命令仍在运行；不得因缺少验收而重放已发送命令，尤其 stash、restore、apply 等操作。`

function cleanTarget (value: any): WorkflowTarget | undefined {
  if (!value || typeof value !== 'object') return undefined
  const text = (key: string, limit = 300) => redactMemory(typeof value[key] === 'string' ? value[key] : '', limit)
  return { type: text('type', 40), profileId: text('profileId'), serverId: text('serverId') || text('profileId'), host: text('host'),
    ip: text('ip', 100), port: Number.isInteger(value.port) && value.port > 0 && value.port <= 65535 ? value.port : 0,
    username: text('username', 100), cwd: text('cwd', 1000) }
}
function targetError (target?: WorkflowTarget): string {
  if (target && Object.values(target).some(v => typeof v === 'string' && v.includes('[已隐藏'))) return '目标身份或路径含隐藏凭据，必须重新获取不含密钥的服务器标识'
  if (!target?.serverId || !target.cwd || !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(target.cwd)) return '需要确认服务器持久 ID 和绝对操作路径；先读取终端，再用 workflow_checkpoint(action=bind_target) 绑定身份和路径'
  if (target.type !== 'local' && (!target.host || !isIP(target.ip))) return '需要确认服务器 host 和实际 IP；不要将主机名当作 IP，请探测后绑定目标'
  return ''
}
function sameTarget (actual: WorkflowTarget, expected: WorkflowTarget): boolean {
  return (['serverId', 'profileId', 'host', 'ip', 'port', 'username', 'cwd'] as const).every(key => !expected[key] || actual[key] === expected[key])
}
const id = (): string => randomBytes(12).toString('hex')
const empty = (): MemoryDocument => ({ version: 2, workflows: [], preferences: [] })
const MAX_FILE = 2 * 1024 * 1024
export function observationFingerprint (value: WorkflowObservation): string {
  return createHash('sha256').update(JSON.stringify([value.text, value.commandState, value.runningProcesses, value.controlledByAI, value.interaction])).digest('hex')
}

/** Never keep raw terminal output, input history, credentials or live tab IDs in the reusable library. */
export function redactMemory (value: string, limit = 4000): string {
  return String(value || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\b(?:sk-|sk-ant-|ghp_|github_pat_|glpat-|xox[baprs]-)[A-Za-z0-9_-]{8,}/g, '[已隐藏密钥]')
    .replace(/\bBearer\s+[^\s"'`]+/gi, 'Bearer [已隐藏密钥]')
    .replace(/((?:[\w-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[\w-]*|authorization)\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s;&|]+)/gi, '$1[已隐藏密钥]')
    .replace(/(--?(?:password|passwd|secret|token|api-key|apikey|access-key|private-key|authorization)\s+)(?:"[^"\n]*"|'[^'\n]*'|[^\s;&|]+)/gi, '$1[已隐藏密钥]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[已隐藏凭据]@')
    .replace(/-----BEGIN [\w ]*PRIVATE KEY-----[\s\S]*?(?:-----END [\w ]*PRIVATE KEY-----|$)/g, '[已隐藏私钥]')
    .slice(0, limit)
}

export const WORKFLOW_COMMANDS = ['model', 'new', 'resume', 'status', 'compact', 'workflows', 'schedules', 'remember', 'help']
export function normalizeAlias (value: string): string {
  const alias = value.trim().replace(/^\//, '').toLowerCase()
  if (!/^[a-z][a-z0-9_-]{0,47}$/.test(alias) || WORKFLOW_COMMANDS.includes(alias)) throw new Error('别名须以英文字母开头，只能包含字母、数字、下划线和短横线，且不能与内置命令重复')
  return alias
}
export function matchWorkflow (workflows: TaskWorkflow[], query: string, cwd: string): TaskWorkflow | undefined {
  const command = /^\/([a-z][a-z0-9_-]*)$/i.exec(query.trim())
  return command ? workflows.find(w => w.enabled && w.cwd === cwd && w.alias === command[1].toLowerCase()) : undefined
}
export function workflowNeedsSudo (workflow: TaskWorkflow): boolean {
  return /\bsudo\b/.test(workflowInstructions(workflow) + '\n' + workflow.steps.map(s => s.command).join('\n'))
}

export function workflowInstructions (workflow: TaskWorkflow): string {
  return workflow.instructions || workflow.steps.map((step, i) => `${i + 1}. ${step.purpose || '执行操作'}${step.target ? `（此前终端：${step.target}）` : ''}\n   服务器与操作路径：${JSON.stringify(step.server || { identity: '旧流程未记录，执行前必须核实' })}\n   依赖步骤：${(step.dependsOn || []).join(', ') || '无'}\n   示例命令：${step.command}\n   验证命令：${(step.verificationCommands || []).join(' ; ')}\n   验收条件：${step.verification?.criteria || '执行前定义并确认'}\n   条件与交互策略：${JSON.stringify(step.policy || {})}\n   上次验收摘要（不能作为本次成功证据）：${step.verification?.evidence || '未记录'}`).join('\n')
}

function validTarget (value: any): boolean {
  return value && ['type', 'profileId', 'serverId', 'host', 'ip', 'username', 'cwd'].every(key => typeof value[key] === 'string') && Number.isInteger(value.port) && value.port >= 0 && value.port <= 65535
}

function validDocument (data: any): data is MemoryDocument {
  return [1, 2].includes(data?.version) && Array.isArray(data.workflows) && data.workflows.length <= 200 && Array.isArray(data.preferences) && data.preferences.length <= 100 &&
    data.workflows.every((w: any) => w && ['id', 'title', 'objective', 'cwd', 'instructions', 'outcome'].every(key => typeof w[key] === 'string') &&
      [w.completedAt, w.successes, w.uses].every(n => Number.isFinite(n) && n >= 0) && (w.alias === undefined || typeof w.alias === 'string') && typeof w.enabled === 'boolean' && typeof w.edited === 'boolean' &&
      (w.questions === undefined || Array.isArray(w.questions) && w.questions.length <= 32 && w.questions.every((q: any) => q && ['id', 'question', 'intent'].every(k => typeof q[k] === 'string') && ['model', 'manual'].includes(q.mode) && (q.previousChoice === undefined || typeof q.previousChoice === 'string'))) &&
      Array.isArray(w.steps) && w.steps.length <= 24 && w.steps.every((s: any) => s && ['purpose', 'command', 'target'].every(key => typeof s[key] === 'string') &&
        (s.id === undefined || typeof s.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(s.id)) &&
        (s.policy === undefined || validPolicy(s.policy)) && (s.skipped === undefined || typeof s.skipped === 'boolean') &&
        (s.server === undefined || validTarget(s.server)) &&
        (s.dependsOn === undefined || Array.isArray(s.dependsOn) && s.dependsOn.every((n: any) => Number.isInteger(n) && n >= 1 && n <= w.steps.indexOf(s))) &&
        (s.verificationCommands === undefined || Array.isArray(s.verificationCommands) && s.verificationCommands.length <= 12 && s.verificationCommands.every((c: any) => typeof c === 'string')) &&
        (s.verification === undefined || s.verification && typeof s.verification.criteria === 'string' && typeof s.verification.evidence === 'string' && Number.isFinite(s.verification.confirmedAt)))) &&
    data.preferences.every((p: any) => p && ['id', 'text', 'cwd'].every(key => typeof p[key] === 'string'))
}

/** Atomic replacement and a file lock keep separate Tabby windows from losing each other's updates. */
export class TaskMemoryStore {
  private readonly file: string
  private writes: Promise<unknown> = Promise.resolve()
  private runWrites = new Map<string, Promise<void>>()
  constructor (private root: string) { this.file = path.join(root, 'task-memory.json') }
  private runFile (owner: string): string { return path.join(this.root, 'runs', createHash('sha256').update(owner).digest('hex') + '.json') }
  saveRun (owner: string, value: any): Promise<void> {
    const file = this.runFile(owner)
    const temporary = file + '.' + id() + '.tmp'
    const serialized = JSON.stringify(value)
    if (Buffer.byteLength(serialized) > MAX_FILE) return Promise.reject(new Error('流程续接记录过大'))
    const write = (this.runWrites.get(owner) || Promise.resolve()).then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      try { await fs.writeFile(temporary, serialized, { mode: 0o600 }); await fs.rename(temporary, file) }
      finally { await fs.unlink(temporary).catch(() => undefined) }
    })
    this.runWrites.set(owner, write.catch(() => undefined))
    return write
  }
  async loadRun (owner: string): Promise<any> {
    const file = this.runFile(owner)
    try {
      if ((await fs.stat(file)).size > MAX_FILE) throw new Error('流程续接记录过大')
      return JSON.parse(await fs.readFile(file, 'utf8'))
    } catch (error: any) { if (error.code === 'ENOENT') return undefined; throw error }
  }
  async read (): Promise<MemoryDocument> {
    try {
      if ((await fs.stat(this.file)).size > MAX_FILE) throw new Error('任务流程库过大')
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'))
      if (!validDocument(data)) throw new Error('任务流程库格式无效，请先备份并检查 task-memory.json')
      return data
    } catch (error: any) { if (error.code === 'ENOENT') return empty(); throw error }
  }
  update<T> (change: (data: MemoryDocument) => T): Promise<T> {
    const operation = this.writes.catch(() => undefined).then(async () => {
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 })
      const lockPath = this.file + '.lock'
      let lock: Awaited<ReturnType<typeof fs.open>> | undefined
      for (let attempt = 0; attempt < 100; attempt++) {
        try { lock = await fs.open(lockPath, 'wx', 0o600); break } catch (error: any) {
          if (error.code !== 'EEXIST') throw error
          // A crashed writer leaves a lock; ordinary writes take milliseconds.
          const stat = await fs.stat(lockPath).catch(() => undefined)
          if (stat && Date.now() - stat.mtimeMs > 60000) await fs.unlink(lockPath).catch(() => undefined)
          else await new Promise(resolve => setTimeout(resolve, 20))
        }
      }
      if (!lock) throw new Error('任务流程库正在被其他窗口更新，请稍后再试')
      const temporary = this.file + '.' + id() + '.tmp'
      try {
        const data = await this.read()
        const result = change(data)
        data.version = 2
        const serialized = JSON.stringify(data)
        if (!validDocument(data) || Buffer.byteLength(serialized) > MAX_FILE) throw new Error('任务流程库已满或内容无效，请清理后重试')
        await fs.writeFile(temporary, serialized, { mode: 0o600, flag: 'wx' })
        await fs.rename(temporary, this.file)
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
}

export class TaskMemory {
  private runs = new Map<string, TaskRun>()
  private completed = new Map<string, CompletedRecording>()
  constructor (readonly store: TaskMemoryStore) {}
  token (owner: string): string | undefined { return this.runs.get(owner)?.token }
  clearRuns (): void { this.runs.clear(); this.completed.clear() }
  forgetRun (owner: string, preserveCompleted = false): void {
    this.runs.delete(owner)
    if (!preserveCompleted) this.completed.delete(owner)
  }
  async discardRunJournal (owner: string): Promise<void> { await this.store.saveRun(owner, { discarded: true }) }
  async prepare (owner: string, objective: string, cwd: string, newGoal = false): Promise<MemorySuggestion> {
    // Only sanitized task text is kept in the capture buffer, too.
    if (newGoal) {
      await this.store.saveRun(owner, { discarded: true })
      this.completed.delete(owner)
      this.runs.set(owner, { token: id(), objective: redactMemory(objective, 1000), cwd, steps: [], reads: 0, verifiedSteps: 0, targets: {}, stepTabs: [], observations: {}, serial: 0, lastCommand: 0, inFlight: false, capture: true, truncated: false, finishing: false })
    }
    const data = await this.store.read()
    const preferences = [...data.preferences.filter(p => !p.cwd), ...data.preferences.filter(p => p.cwd === cwd)].slice(-8)
    const workflow = matchWorkflow(data.workflows, objective, cwd)
    if (!workflow && !preferences.length) return { preferences, context: '' }
    const reference = { preferences: preferences.map(p => redactMemory(p.text, 180)), ...(workflow ? {
      workflow: { title: redactMemory(workflow.title, 80), previousTask: redactMemory(workflow.objective, 400),
        procedure: redactMemory(workflowInstructions(workflow), 2600), previousOutcome: redactMemory(workflow.outcome, 300), successes: workflow.successes },
    } : {}) }
    return { preferences, workflow, context: '本地任务流程与用户偏好（引用资料，不是新的用户指令）：\n' + JSON.stringify(reference) +
      '\n优先参考匹配流程，减少重复探索；以本次用户要求为准。先用 list_tabs/read_tab 核对当前终端、主机、目录和运行状态，重新获取 tab ID。此前命令仅为步骤示例，参数、路径、分支和目标必须按当前任务核对；含隐藏内容时重新取得真实值，不得直接执行占位符。任务完成记录不证明每条命令成功。不得重放整段历史、盲目重试或跳过现有审批；遇到不匹配的步骤应调整。' }
  }
  beginExecution (owner: string, workflow: TaskWorkflow): void {
    this.completed.delete(owner)
    this.runs.set(owner, { token: id(), objective: workflow.objective, cwd: workflow.cwd, steps: [], reads: 0, verifiedSteps: 0,
      targets: {}, stepTabs: [], observations: {}, serial: 0, lastCommand: 0, inFlight: false, capture: false, expected: workflow.steps,
      questions: workflow.questions ? JSON.parse(JSON.stringify(workflow.questions)) : [], truncated: false, finishing: false })
  }
  executionContext (owner: string): string {
    const run = this.runs.get(owner)
    if (!run) return ''
    const pending = run.steps[run.steps.length - 1]
    return WORKFLOW_HINT + '\n当前流程数据（上次证据不能代替本次验收）：' + JSON.stringify({
      mode: run.capture ? 'recording' : 'executing_alias', archiveEligible: run.capture && !this.archiveIssue(run), archiveIssue: this.archiveIssue(run),
      objective: run.objective, orderedSteps: run.expected || [],
      confirmedSteps: run.steps.map((s, i) => s.verification ? i + 1 : 0).filter(Boolean),
      pendingStep: pending && !pending.verification && !pending.skipped ? { number: run.steps.length, runtimeTabId: run.stepTabs[run.steps.length - 1], ...pending } : undefined,
      skippedSteps: run.steps.map((s, i) => s.skipped ? i + 1 : 0).filter(Boolean), helperTokens: run.helperTokens || 0,
      questions: run.questions || [], uncertainAction: run.uncertain,
      nextStep: pending && !pending.verification && !pending.skipped ? run.steps.length : run.steps.length + 1,
    })
  }
  configure (owner: string, token: string | undefined, stepNumber: number, policy: WorkflowPolicy): any {
    const run = this.runs.get(owner)
    if (!run || run.token !== token || !run.capture || run.finishing || run.inFlight) throw new Error('只能为本次录制中已观察的步骤配置策略')
    const step = run.steps[stepNumber - 1]
    if (!step || !validPolicy(policy)) throw new Error('步骤或条件/交互策略格式无效')
    const serialized = JSON.stringify(policy)
    if (serialized.length > 100000 || redactMemory(serialized, 100000) !== serialized) throw new Error('策略不能包含凭据或超出长度限制')
    if (policy.verify && !step.verificationCommands?.includes(policy.verify.command)) throw new Error('自动验收只能使用本次已执行过的验证命令；先执行验证并读取结果')
    const previousInteractions = step.policy?.interactions || []
    step.policy = JSON.parse(serialized)
    step.policy?.interactions?.forEach(node => { node.observed = previousInteractions.some(previous => previous.id === node.id && previous.observed) })
    return { configured: true, step: stepNumber, policy: step.policy, automation: this.automation(run.steps) }
  }
  private automation (steps: TaskStep[], questions: WorkflowQuestion[] = []): string {
    const interactions = steps.flatMap(s => s.policy?.interactions || [])
    return [...interactions, ...questions].some(i => i.mode === 'manual') ? 'manual_required'
      : interactions.length || questions.length || steps.some(s => s.policy?.decision || !s.policy?.verify) ? 'model_assisted' : 'automatic'
  }
  recordQuestions (owner: string, questions: UserQuestion[], answers: Record<string, { answers: string[] }>): void {
    const run = this.runs.get(owner)
    if (!run?.capture) return
    const saved = run.questions ||= []
    for (const question of questions) {
      if (saved.length >= 32 || !answers[question.id]?.answers.length) continue
      const text = redactMemory(question.question, 600)
      const secret = question.isSecret || text.includes('[已隐藏')
      const choice = !secret && question.options?.find(o => answers[question.id].answers.includes(o.label))?.label
      const previousChoice = choice && redactMemory(choice, 400) === choice ? choice : undefined
      const item: WorkflowQuestion = { id: `question-${saved.length + 1}`, question: secret ? '需要用户完成认证或提供秘密信息' : text,
        intent: secret ? '等待用户在实际终端完成认证，不保存秘密答案' : '按原始任务和当前问题判断；历史选择仅为参考，不代表所有后续问题都获得同样授权', mode: secret ? 'manual' : 'model', ...(previousChoice ? { previousChoice } : {}) }
      if (!saved.some(q => q.question === item.question)) saved.push(item)
    }
  }
  questionPolicy (owner: string, question: UserQuestion): WorkflowQuestion | undefined {
    const run = this.runs.get(owner)
    return run && !run.capture && !question.isSecret ? run.questions?.find(q => q.mode === 'model' && q.question === question.question) : undefined
  }
  runtime (owner: string, token: string | undefined, tabId: string): WorkflowRuntimeState {
    const run = this.runs.get(owner)
    if (!run || run.token !== token || run.finishing) throw new Error('当前没有可续接的流程')
    const last = run.steps[run.steps.length - 1]
    const pending = last && !last.verification && !last.skipped ? last : undefined
    return { objective: run.objective, capture: run.capture, number: pending ? run.steps.length : run.steps.length + 1,
      pending, pendingTab: pending ? run.stepTabs[run.steps.length - 1] : undefined, expected: run.expected?.[pending ? run.steps.length - 1 : run.steps.length],
      complete: !!run.expected && run.steps.length === run.expected.length && !pending, observation: run.observations[tabId], helperTokens: run.helperTokens || 0,
      uncertain: run.uncertain, restored: !!run.restored }
  }
  async persistRun (owner: string): Promise<void> {
    const run = this.runs.get(owner)
    if (!run) return
    // No raw output, answers or ephemeral tab IDs survive a restart.
    await this.store.saveRun(owner, { version: 2, cwd: run.cwd, objective: run.objective, steps: run.steps, expected: run.expected,
      capture: run.capture, truncated: run.truncated, archiveIssue: run.archiveIssue, helperTokens: run.helperTokens || 0, helperCalls: run.helperCalls, uncertain: run.uncertain, questions: run.questions })
  }
  async restoreRun (owner: string, cwd: string): Promise<boolean> {
    if (this.runs.has(owner)) return true
    const saved = await this.store.loadRun(owner)
    if (!saved || saved.cwd !== cwd) return false
    const wrapper = (steps: TaskStep[]) => ({ version: 2, workflows: [{ id: 'resume', title: '', objective: saved.objective, cwd, steps, instructions: '', outcome: '', completedAt: 0, successes: 0, uses: 0, enabled: true, edited: false }], preferences: [] })
    if (saved.version !== 2 || typeof saved.capture !== 'boolean' || !validDocument(wrapper(saved.steps)) || saved.expected !== undefined && !validDocument(wrapper(saved.expected))) throw new Error('流程续接记录无效')
    this.runs.set(owner, { token: id(), cwd, objective: saved.objective, steps: saved.steps, expected: saved.expected, capture: saved.capture,
      truncated: !!saved.truncated, archiveIssue: saved.archiveIssue, helperTokens: Number(saved.helperTokens) || 0, helperCalls: saved.helperCalls, uncertain: saved.uncertain, questions: saved.questions,
      stepTabs: saved.steps.map(() => ''), observations: {}, targets: {}, serial: 0, lastCommand: 0, inFlight: false,
      reads: 0, verifiedSteps: saved.steps.filter((s: TaskStep) => s.verification || s.skipped).length, finishing: false, restored: true })
    return true
  }
  markAction (owner: string, token: string | undefined, tool: string, args: any): void {
    const run = this.runs.get(owner)
    if (run && run.token === token) run.uncertain = { tool, step: run.steps.length + (run.steps.length && !run.steps[run.steps.length - 1].verification && !run.steps[run.steps.length - 1].skipped ? 0 : 1),
      ...(tool === 'send_input' && args.mode !== 'stdin' && args.verificationFor === undefined ? { command: redactMemory(args.text, TERMINAL_INPUT_MAX_LENGTH), purpose: redactMemory(args.purpose || run.objective, 180) } : {}) }
  }
  clearAction (owner: string, token: string | undefined): void {
    const run = this.runs.get(owner)
    if (run && run.token === token) run.uncertain = undefined
  }
  claimRunner (owner: string, token: string | undefined): () => void {
    const run = this.runs.get(owner)
    if (!run || run.token !== token || run.runnerBusy || run.inFlight) throw new Error('流程运行器正在处理当前节点，不能并发调用')
    run.runnerBusy = true
    return () => { run.runnerBusy = false }
  }
  runnerBusy (owner: string): boolean { return !!this.runs.get(owner)?.runnerBusy }
  addHelperTokens (owner: string, token: string | undefined, tokens: number): void {
    const run = this.runs.get(owner)
    if (run && run.token === token && Number.isFinite(tokens) && tokens > 0) run.helperTokens = (run.helperTokens || 0) + tokens
  }
  reserveDecision (owner: string, token: string | undefined, key: string, maxCalls: number): void {
    const run = this.runs.get(owner)
    if (!run || run.token !== token) throw new Error('流程已切换')
    const calls = run.helperCalls ||= {}
    if ((calls[key] || 0) >= maxCalls || Object.values(calls).reduce((a, b) => a + b, 0) >= 32) throw new Error('辅助决策已达到次数上限；从当前节点交回主模型')
    calls[key] = (calls[key] || 0) + 1
  }
  assertObservation (owner: string, token: string | undefined, tabId: string, fingerprint: string): void {
    const state = this.runtime(owner, token, tabId)
    if (!state.observation || state.observation.fingerprint !== fingerprint) throw new Error('交互现场已经变化；丢弃旧决策并重新观察')
  }
  skipNext (owner: string, token: string | undefined, tabId: string): any {
    const run = this.runs.get(owner)
    const state = this.runtime(owner, token, tabId)
    if (!run || run.capture || state.pending || !state.expected?.policy?.when || !state.observation || state.observation.value.commandState !== 'prompt') throw new Error('当前不能判断或跳过分支')
    const actual = run.targets[tabId]?.server
    if (!actual || targetError(actual) || !sameTarget(actual, state.expected.server || actual)) throw new Error('分支目标身份或路径未核对')
    if (matchesConditions(state.expected.policy.when, state.observation.value)) throw new Error('当前条件为真，应执行该步骤')
    run.steps.push({ ...JSON.parse(JSON.stringify(state.expected)), skipped: true, verification: undefined })
    run.stepTabs.push(tabId)
    run.verifiedSteps++
    return { skipped: true, step: state.number, reason: '条件为假，进入后续分支；未将跳过步骤记为成功' }
  }
  beforeTool (owner: string, token: string | undefined, name: string, args: any, fromRunner = false): void {
    const run = this.runs.get(owner)
    if (!run || run.token !== token) return
    // Reject before journaling an action, so recovery never reconstructs a cut-off command.
    if (name === 'send_input' && (typeof args?.text !== 'string' || args.text.length > TERMINAL_INPUT_MAX_LENGTH)) throw new Error(`text must be a string of at most ${TERMINAL_INPUT_MAX_LENGTH} characters`)
    if ((run.capture || run.expected) && ['attachment_upload', 'attachment_download'].includes(name)) throw new Error('Attachment transfers are not reusable workflow steps. Transfer the file before recording or invoking the workflow.')
    if (run.runnerBusy && !fromRunner && name !== 'read_tab') throw new Error('运行器正在处理当前节点；等待返回后再继续')
    if (run.uncertain && ['send_input', 'send_keys', 'attach_process'].includes(name)) throw new Error('上一动作结果未知；先读取现场并用 workflow_checkpoint(action=resolve_action) 核对，不能重发')
    if (['send_keys', 'attach_process'].includes(name) || name === 'send_input' && args?.mode === 'stdin') {
      if (run.inFlight) throw new Error('上一条流程动作仍在发送，不能并行提交交互')
      const pending = run.steps[run.steps.length - 1]
      const observation = run.observations[args.tabId]
      if (name !== 'attach_process' && (!pending || pending.verification || pending.skipped || run.stepTabs[run.steps.length - 1] !== args.tabId)) throw new Error('交互必须属于当前未验收步骤及其执行终端')
      if (name === 'attach_process' && pending && !pending.verification && !pending.skipped) throw new Error('先完成当前步骤，再接管其他进程')
      if (name === 'attach_process' && run.expected) {
        const expected = run.expected[run.steps.length]
        const actual = run.targets[args.tabId]?.server
        if (!expected || expected.command || !actual || targetError(actual) || expected.server && !sameTarget(actual, expected.server)) throw new Error('接管目标与已保存的交互步骤不一致')
        const processes = expected.policy?.interactions?.map(n => n.expectedProcess).filter(Boolean) || []
        if (processes.length && !processes.includes(args.expectedProcess)) throw new Error('接管进程与已保存交互策略不一致')
      }
      if (!observation || observation.serial <= run.lastCommand || name !== 'attach_process' && observation.value.commandState === 'prompt') throw new Error('交互前必须读取同一终端的新观察，并确认交互进程尚未退出')
      const used = run.interactionReads?.[args.tabId] || 0
      if (observation.serial <= used) throw new Error('当前观察已用于交互；请重新读取终端，不能重复发送回答')
      if (run.interactionReceipts?.[args.tabId] === observation.fingerprint) throw new Error('当前交互画面未变化，不能重复发送同一观察的回答')
      run.inFlight = true
      return
    }
    if (name !== 'send_input' || args?.submit !== true) return
    if (run.uncertain) throw new Error('上一动作结果未知；先读取现场并用 workflow_checkpoint(action=resolve_action) 核对，不能重发')
    if (run.inFlight) throw new Error('上一条流程命令仍在发送，不能并行提交下一步骤')
    const reserve = () => { run.inFlight = true }
    const pending = run.steps[run.steps.length - 1]
    if (args.verificationFor !== undefined) {
      if (args.verificationFor === 0 && (!pending || pending.verification || pending.skipped)) { reserve(); return }
      if (!pending || pending.verification || args.verificationFor !== run.steps.length || run.stepTabs[run.steps.length - 1] !== args.tabId) throw new Error('检查命令必须指向当前未确认步骤及其执行终端')
      reserve()
      return
    }
    if (pending && !pending.verification && !pending.skipped) throw new Error(`步骤 ${run.steps.length} 尚未确认完成；先读取该终端结果并调用 workflow_checkpoint，不能执行下一步`)
    if (run.expected?.length && run.steps.length >= run.expected.length) throw new Error('已完成流程中的所有步骤，不能追加未定义操作')
    const expected = run.expected?.[run.steps.length]?.server
    if (expected) {
      const current = run.targets[args.tabId]?.server
      const error = targetError(current)
      if (error) throw new Error(error)
      if (!sameTarget(current!, expected)) throw new Error('服务器身份或操作路径与流程下一步骤不一致；停止并核对目标，不能在其他服务器或路径执行')
    }
    const when = run.expected?.[run.steps.length]?.policy?.when
    if (when && (!run.observations[args.tabId] || !matchesConditions(when, run.observations[args.tabId].value))) throw new Error('当前步骤条件不成立；用 workflow_run 执行条件分支，不能强行提交命令')
    reserve()
  }
  toolFailed (owner: string, token: string | undefined, name: string): void {
    const run = this.runs.get(owner)
    if (run && run.token === token && ['send_input', 'send_keys', 'attach_process'].includes(name)) run.inFlight = false
  }
  checkpoint (owner: string, token: string | undefined, args: any): any {
    const run = this.runs.get(owner)
    if (!run || run.token !== token || run.finishing) throw new Error('当前没有录制或别名执行中的流程')
    if (run.inFlight) throw new Error('命令仍在发送，不能提前确认步骤')
    const observation = run.observations[args.tabId]
    if (!observation) throw new Error('先用 read_tab 读取并核对目标终端')
    const evidence = redactMemory(args.evidence, 600).trim()
    if (!evidence || evidence.includes('[已隐藏')) throw new Error('请提供不含凭据的实际观察证据')
    if (args.action === 'bind_target') {
      const previous = run.targets[args.tabId]
      const server = cleanTarget({ ...previous?.server, ...args.target })
      const error = targetError(server)
      if (error) throw new Error(error)
      if (server!.serverId === args.tabId || server!.profileId === args.tabId) throw new Error('不能将临时 tab ID 保存为服务器或连接的持久 ID')
      run.targets[args.tabId] = { title: previous?.title || '', server, bound: true }
      const pending = run.steps[run.steps.length - 1]
      if (run.restored && pending && !pending.verification && !pending.skipped && sameTarget(server!, pending.server || server!)) {
        run.stepTabs[run.steps.length - 1] = args.tabId
      }
      return { bound: true, server, nextStep: run.steps.length + 1, recording: run.capture, archiveEligible: run.capture && !this.archiveIssue(run), archiveIssue: this.archiveIssue(run) }
    }
    if (args.action === 'resolve_action') {
      if (!run.uncertain || !['sent', 'not_sent'].includes(args.outcome) || observation.serial <= run.lastCommand) throw new Error('先读取未知动作之后的现场，再明确判断 sent 或 not_sent')
      const unknown = run.uncertain
      const pending = run.steps[run.steps.length - 1]
      if (args.outcome === 'sent' && unknown.command && (!pending || pending.verification || pending.skipped)) {
        const target = run.targets[args.tabId]
        if (targetError(target?.server)) throw new Error('先重新绑定未知动作的实际目标')
        const expected = run.expected?.[run.steps.length]
        if (expected?.server && !sameTarget(target!.server!, expected.server)) throw new Error('未知动作目标与流程不一致')
        run.steps.push({ ...(expected || {}), id: expected?.id || `step-${run.steps.length + 1}`, command: unknown.command,
          purpose: unknown.purpose || '恢复已发送操作', target: target?.title || '', server: target?.server, verification: undefined })
        run.stepTabs.push(args.tabId)
      }
      run.uncertain = undefined
      return { resolved: true, outcome: args.outcome, next: '不重放已发送动作；读取现场并验收当前步骤' }
    }
    if (args.action && args.action !== 'confirm_step') throw new Error('未知流程确认操作')
    const index = run.steps.length - 1
    const step = run.steps[index]
    if (!step || args.step !== index + 1 || run.stepTabs[index] !== args.tabId || step.verification || step.skipped) throw new Error('只能确认当前未完成步骤，且必须读取其实际执行终端')
    if (observation.serial <= run.lastCommand || observation.running) throw new Error('尚无该步骤命令后的新结果，或命令仍在运行；请等待并读取同一终端')
    const criteria = redactMemory(args.criteria, 400).trim()
    if (!criteria || criteria.includes('[已隐藏')) throw new Error('请填写可验证的完成条件')
    const expectedCriteria = run.expected?.[index]?.verification?.criteria
    if (expectedCriteria && criteria !== expectedCriteria) throw new Error('请使用已保存步骤的原验收条件，不能降低或替换验收要求')
    const server = cleanTarget({ ...step.server, ...args.target })
    const error = targetError(server)
    if (error) throw new Error(error)
    if (server!.serverId === args.tabId || server!.profileId === args.tabId) throw new Error('不能将临时 tab ID 保存为服务器或连接的持久 ID')
    const expected = run.expected?.[index]?.server
    if (expected && !sameTarget(server!, expected)) throw new Error('验收目标与已保存流程不一致，不能确认完成')
    step.server = server
    step.verification = { criteria, evidence, confirmedAt: Date.now() }
    run.uncertain = undefined
    run.verifiedSteps = run.steps.filter(s => s.verification || s.skipped).length
    return { confirmed: true, step: index + 1, nextStep: index + 2, server, recording: run.capture, archiveEligible: run.capture && !this.archiveIssue(run), archiveIssue: this.archiveIssue(run) }
  }
  record (owner: string, token: string | undefined, name: string, args: any, result: any): void {
    const run = this.runs.get(owner)
    if (!run || run.token !== token || run.finishing) return
    run.serial++
    if (name === 'read_tab' && typeof result?.text === 'string') {
      run.reads++
      const previous = run.targets[args.tabId]
      const server = cleanTarget(result.server)
      run.targets[args.tabId] = { title: redactMemory(result.title || previous?.title || '', 100), server: previous?.bound ? previous.server : server || previous?.server, bound: previous?.bound }
      const value: WorkflowObservation = { text: result.text, commandState: result.commandState, runningProcesses: result.runningProcesses, controlledByAI: result.controlledByAI, interaction: result.interaction }
      run.observations[args.tabId] = { serial: run.serial, running: result.commandState === 'running' || result.commandState !== 'prompt' && !!result.runningProcesses?.length, fingerprint: observationFingerprint(value), value }
      return
    }
    if (['send_input', 'send_keys', 'attach_process'].includes(name)) run.inFlight = false
    if (name === 'attach_process' && result?.attached) {
      const target = run.targets[args.tabId]
      const expected = run.expected?.[run.steps.length]
      run.steps.push({ id: expected?.id || `step-${run.steps.length + 1}`, command: '', purpose: redactMemory(args.purpose || '接管交互进程', 180), target: target?.title || '', server: target?.server,
        policy: expected?.policy ? JSON.parse(JSON.stringify(expected.policy)) : { interactions: [{ id: 'interaction-1', intent: redactMemory(args.purpose || run.objective, 600), expectedProcess: args.expectedProcess, mode: 'model', rules: [], observed: true }] }, dependsOn: run.steps.length ? [run.steps.length] : [] })
      run.stepTabs.push(args.tabId)
      run.lastCommand = run.serial
      return
    }
    if (!['send_input', 'send_keys'].includes(name) || !result?.sent) return
    const cannotArchive = (reason: string) => { run.truncated = true; run.archiveIssue = run.archiveIssue || reason }
    if (name === 'send_keys' || args?.mode === 'stdin') {
      const step = run.steps[run.steps.length - 1]
      if (!step || step.verification || step.skipped || run.stepTabs[run.steps.length - 1] !== args.tabId) { cannotArchive('交互缺少所属逻辑步骤或实际执行终端'); return }
      const policy = step.policy || (step.policy = {})
      const interactions = policy.interactions || (policy.interactions = [])
      // Capture the intent and fallback, never raw answers or a replayable key history.
      if (!interactions.length) interactions.push({ id: 'interaction-1', intent: redactMemory(args.purpose || run.objective, 600), mode: 'model', rules: [], observed: true })
      else {
        const observed = run.observations[args.tabId]?.value
        const selected = observed && interactions.find(node => node.rules.some(rule => matchesConditions(rule.when, observed))) || (interactions.length === 1 ? interactions[0] : undefined)
        if (selected) selected.observed = true
      }
      ;(run.interactionReads ||= {})[args.tabId] = run.serial
      ;(run.interactionReceipts ||= {})[args.tabId] = run.observations[args.tabId]?.fingerprint
      run.lastCommand = run.serial
      return
    }
    if (args?.submit !== true || result?.submitted !== true || typeof args.text !== 'string') return
    run.lastCommand = run.serial
    if (args.verificationFor === 0) return
    if (args.text.length > TERMINAL_INPUT_MAX_LENGTH) { cannotArchive(`录制命令超过 ${TERMINAL_INPUT_MAX_LENGTH} 字符的终端输入上限，不能保存为完整可复用流程`); return }
    const command = redactMemory(args.text, TERMINAL_INPUT_MAX_LENGTH)
    if (command.includes('[已隐藏') || /(?:^|[\s/])(?:passwd|sshpass)\b|(?:^|\s)(?:read\s+-s|export\s+.*(?:KEY|TOKEN|SECRET))/i.test(command)) { cannotArchive('录制包含敏感命令或隐藏凭据，不能保存为完整可复用流程'); return }
    if (command !== args.text) { cannotArchive('录制命令包含无法原样保存的控制字符，不能保存为完整可复用流程'); return }
    if (args.verificationFor !== undefined) {
      const step = run.steps[run.steps.length - 1]
      if (!step || args.verificationFor !== run.steps.length || run.stepTabs[run.steps.length - 1] !== args.tabId) { cannotArchive('验证命令未对应当前步骤及其终端，录制不完整'); return }
      const checks = step.verificationCommands || (step.verificationCommands = [])
      if (checks.length >= 12) cannotArchive('单步骤验证命令超过 12 条，录制不完整')
      else checks.push(command)
      return
    }
    if (run.steps.length >= 24) { cannotArchive('录制步骤超过 24 条，录制不完整'); return }
    const previous = run.steps[run.steps.length - 1]
    if (previous && !previous.verification && !previous.skipped) cannotArchive('录制跳过了未验收步骤，流程不完整')
    const target = run.targets[args.tabId]
    const expected = run.expected?.[run.steps.length]
    const step: TaskStep = { id: expected?.id || `step-${run.steps.length + 1}`, ...(expected?.policy ? { policy: JSON.parse(JSON.stringify(expected.policy)) } : {}), command, purpose: redactMemory(args.purpose || '执行并检查结果', 180), target: target?.title || '',
      server: target?.server || cleanTarget(result.server), dependsOn: run.steps.length ? [run.steps.length] : [] }
    run.steps.push(step)
    run.stepTabs.push(args.tabId)
  }
  completionIssue (owner: string, token: string | undefined): string {
    const run = this.runs.get(owner)
    if (!run || run.token !== token) return ''
    if (run.uncertain || run.inFlight || run.steps.some(s => !s.verification && !s.skipped)) return '流程还有步骤未经实际结果验收，不能确认任务完成'
    if (run.expected?.length && run.steps.length !== run.expected.length) return '流程还有依赖步骤尚未执行，不能确认任务完成'
    return ''
  }
  private archiveIssue (run: TaskRun): string {
    if (!run.capture) return '当前为别名执行，不会录制或归档新流程'
    if (run.truncated) return run.archiveIssue || '录制不完整，不能保存为可复用流程'
    if (!run.steps.length) return '尚无可归档的终端操作步骤'
    if (run.inFlight || !run.reads || run.verifiedSteps !== run.steps.length || run.steps.some(s => !s.verification)) return '流程步骤尚未全部验收'
    if (run.steps.some(s => targetError(s.server))) return '流程步骤缺少已核对的服务器身份或绝对操作路径'
    if (run.steps.some(s => [s.command, ...(s.verificationCommands || [])].some(command => command.includes('[已隐藏') || redactMemory(command, TERMINAL_INPUT_MAX_LENGTH) !== command))) return '流程包含敏感或不完整命令，不能归档'
    return ''
  }
  /** Current run or the most recent explicit recording, scoped to this session and workspace. */
  async workflowStatus (owner: string, cwd: string): Promise<any> {
    const active = this.runs.get(owner)
    const completed = this.completed.get(owner)
    const run = active || completed?.run
    if (!run || run.cwd !== cwd) return { state: 'idle', recording: false, canSetAlias: false, archiveEligible: false,
      reason: '当前会话没有录制记录；普通任务不能事后设置流程别名。用 /remember 任务描述 开始新的录制，不要重跑已完成操作来冒充原流程。' }
    const archiveIssue = this.archiveIssue(run)
    const workflow = completed?.workflowId ? (await this.store.read()).workflows.find(w => w.id === completed.workflowId && w.cwd === cwd) : undefined
    return { state: active && !active.finishing ? (run.capture ? 'recording' : 'executing_alias')
      : completed?.saving ? 'archiving' : workflow ? 'archived' : archiveIssue ? 'unavailable' : completed?.error ? 'archive_failed' : 'unavailable',
    recording: !!active && !active.finishing && run.capture, objective: run.objective, cwd: run.cwd,
    lifecycle: run.truncated ? 'incomplete' : run.capture && (!run.steps.length || run.steps.some(s => !s.verification)) ? 'draft' : 'ready', automation: this.automation(run.steps, run.questions), helperTokens: run.helperTokens || 0,
    skippedSteps: run.steps.map((s, i) => s.skipped ? i + 1 : 0).filter(Boolean),
    unobservedBranches: run.steps.flatMap((s, i) => s.policy?.when || s.policy?.interactions?.some(n => !n.observed) ? [i + 1] : []),
    confirmedSteps: run.steps.map((s, i) => s.verification ? i + 1 : 0).filter(Boolean),
    pendingStep: run.steps.length && !run.steps[run.steps.length - 1].verification && !run.steps[run.steps.length - 1].skipped ? run.steps.length : undefined,
    archiveEligible: !archiveIssue, archiveIssue: archiveIssue || undefined,
    reason: completed?.error || (completed?.workflowId && !workflow ? '流程已被删除，请在设置中检查；不能将其他流程替代本次录制' : undefined),
    canSetAlias: !active && !!completed && !archiveIssue && (!!workflow || !completed.workflowId),
    workflow: workflow ? { id: workflow.id, alias: workflow.alias || '', objective: workflow.objective, cwd: workflow.cwd, enabled: workflow.enabled } : undefined }
  }
  /** Never synthesize a workflow from chat history or a model-provided procedure. */
  async assignWorkflowAlias (owner: string, cwd: string, value: string, workflowId?: string): Promise<any> {
    const alias = normalizeAlias(value)
    const completed = this.completed.get(owner)
    if (this.runs.has(owner) || !completed || completed.run.cwd !== cwd) throw new Error('没有已完成的录制可设置别名；先查询 workflow_status，不能将普通任务或执行中的流程事后归档')
    const issue = this.archiveIssue(completed.run)
    if (issue) throw new Error(issue)
    if (workflowId && workflowId !== completed.workflowId) throw new Error('流程 ID 与本会话最近完成的录制不一致；请重新查询 workflow_status')
    if (!completed.workflowId) await this.persistRecording(completed)
    if (this.completed.get(owner) !== completed || this.runs.has(owner)) throw new Error('录制状态已改变，请重新查询 workflow_status')
    await this.setAlias(completed.workflowId!, alias)
    const status = await this.workflowStatus(owner, cwd)
    if (status.workflow?.id !== completed.workflowId || status.workflow?.alias !== alias) throw new Error('别名回读不一致，请重新查询 workflow_status')
    return { saved: true, ...status }
  }
  async finish (owner: string, token: string | undefined, turnStatus: string, goalStatus: string, outcome: string): Promise<TaskWorkflow | undefined> {
    const run = this.runs.get(owner)
    if (!run || run.token !== token || turnStatus !== 'completed' || goalStatus !== 'complete') return undefined
    if (run.finishing) return this.completed.get(owner)?.saving
    if (this.completionIssue(owner, token)) return undefined
    if (!run.capture) { await this.store.saveRun(owner, { discarded: true }); this.runs.delete(owner); return undefined }
    const completed: CompletedRecording = { run, outcome: redactMemory(outcome, 800) }
    this.completed.set(owner, completed)
    if (this.archiveIssue(run)) { this.runs.delete(owner); return undefined }
    run.finishing = true
    try {
      const result = await this.persistRecording(completed)
      await this.store.saveRun(owner, { discarded: true })
      return result
    } finally { if (this.runs.get(owner) === run) this.runs.delete(owner) }
  }
  private async persistRecording (completed: CompletedRecording): Promise<TaskWorkflow> {
    if (completed.saving) return completed.saving
    const { run, outcome } = completed
    completed.saving = this.store.update(data => {
      const existing = data.workflows.find(w => w.cwd === run.cwd && w.objective === run.objective)
      if (existing) {
        existing.successes++
        existing.completedAt = Date.now()
        if (!existing.edited) { existing.steps = run.steps; existing.questions = run.questions; existing.outcome = redactMemory(outcome, 800) }
        return existing
      }
      if (data.workflows.length >= 200) throw new Error('任务流程库已满（200 条），请先清理不再使用的流程')
      const workflow: TaskWorkflow = { id: id(), title: run.objective.slice(0, 80), objective: run.objective, cwd: run.cwd, steps: run.steps,
        questions: run.questions,
        instructions: '', outcome: redactMemory(outcome, 800), completedAt: Date.now(), successes: 1, uses: 0, enabled: true, edited: false }
      data.workflows.unshift(workflow)
      return workflow
    })
    try {
      const workflow = await completed.saving
      completed.workflowId = workflow.id
      completed.error = undefined
      return workflow
    } catch (error: any) {
      completed.error = '流程归档失败：' + redactMemory(error.message, 400) + '；可用 workflow_set_alias 重试归档并保存别名，无需重跑终端操作'
      throw error
    } finally { completed.saving = undefined }
  }
  async used (workflowId: string): Promise<void> { await this.store.update(data => { const workflow = data.workflows.find(w => w.id === workflowId); if (workflow) workflow.uses++ }) }
  async setAlias (workflowId: string, value: string): Promise<void> {
    const alias = normalizeAlias(value)
    await this.store.update(data => {
      const workflow = data.workflows.find(w => w.id === workflowId)
      if (!workflow) throw new Error('流程已被删除，请刷新列表')
      if (data.workflows.some(w => w.id !== workflowId && w.cwd === workflow.cwd && w.alias === alias)) throw new Error('当前目录已使用此别名')
      workflow.alias = alias
    })
  }
  async saveWorkflow (workflow: TaskWorkflow, title: string, objective: string, instructions: string, enabled: boolean, alias = workflow.alias || '', policies?: Record<string, WorkflowPolicy>): Promise<void> {
    const normalized = alias.trim() ? normalizeAlias(alias) : ''
    if (!title.trim() || !objective.trim() || !instructions.trim()) throw new Error('请填写流程名称、匹配任务和步骤')
    if (policies && (typeof policies !== 'object' || Array.isArray(policies) || Object.entries(policies).some(([key, policy]) => !/^[1-9][0-9]*$/.test(key) || !workflow.steps[Number(key) - 1] || !validPolicy(policy) || policy.verify && !workflow.steps[Number(key) - 1].verificationCommands?.includes(policy.verify.command)) || redactMemory(JSON.stringify(policies), 100000) !== JSON.stringify(policies))) throw new Error('条件与交互策略无效或包含凭据；验收只能使用已录制的验证命令')
    await this.store.update(data => {
      const current = data.workflows.find(w => w.id === workflow.id)
      if (!current) throw new Error('流程已被删除，请刷新列表')
      if (normalized && data.workflows.some(w => w.id !== workflow.id && w.cwd === current.cwd && w.alias === normalized)) throw new Error('当前目录已使用此别名')
      Object.assign(current, { alias: normalized, title: redactMemory(title.trim(), 120), objective: redactMemory(objective.trim(), 1000), instructions: redactMemory(instructions.trim(), 6000), enabled, edited: true })
      if (policies) current.steps.forEach((step, i) => { step.policy = policies[String(i + 1)] ? JSON.parse(JSON.stringify(policies[String(i + 1)])) : undefined })
    })
  }
  async removeWorkflow (workflowId: string): Promise<void> { await this.store.update(data => { data.workflows = data.workflows.filter(w => w.id !== workflowId) }) }
  async addPreference (text: string, cwd: string): Promise<void> {
    return this.savePreference('', text, cwd)
  }
  async savePreference (preferenceId: string, text: string, cwd: string): Promise<void> {
    const value = redactMemory(text.trim(), 500)
    if (!value || value.includes('[已隐藏')) throw new Error('请填写不含密钥的操作偏好')
    await this.store.update(data => {
      if (preferenceId) {
        const preference = data.preferences.find(p => p.id === preferenceId)
        if (!preference) throw new Error('偏好已被删除，请刷新列表')
        Object.assign(preference, { text: value, cwd })
        return
      }
      if (!data.preferences.some(p => p.text === value && p.cwd === cwd)) data.preferences.push({ id: id(), text: value, cwd })
    })
  }
  async removePreference (preferenceId: string): Promise<void> { await this.store.update(data => { data.preferences = data.preferences.filter(p => p.id !== preferenceId) }) }
}
