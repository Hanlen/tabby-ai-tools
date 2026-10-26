import { promises as fs } from 'fs'
import * as path from 'path'
import { randomBytes } from 'crypto'
import { isIP } from 'net'

export interface WorkflowTarget {
  type: string; profileId: string; serverId: string; host: string; ip: string; port: number; username: string; cwd: string
}
export interface StepVerification { criteria: string; evidence: string; confirmedAt: number }
export interface TaskStep {
  purpose: string; command: string; target: string; server?: WorkflowTarget
  dependsOn?: number[]; verification?: StepVerification; verificationCommands?: string[]
}
export interface TaskWorkflow {
  id: string; alias?: string; title: string; objective: string; cwd: string; steps: TaskStep[]; instructions: string
  outcome: string; completedAt: number; successes: number; uses: number; enabled: boolean; edited: boolean
}
export interface TaskPreference { id: string; text: string; cwd: string }
export interface MemoryDocument { version: 1; workflows: TaskWorkflow[]; preferences: TaskPreference[] }
export interface MemorySuggestion { workflow?: TaskWorkflow; preferences: TaskPreference[]; context: string }
interface TaskRun {
  token: string; cwd: string; objective: string; steps: TaskStep[]; reads: number; verifiedSteps: number
  targets: Record<string, { title: string; server?: WorkflowTarget; bound?: boolean }>; stepTabs: string[]; observations: Record<string, { serial: number; running: boolean }>
  serial: number; lastCommand: number; inFlight: boolean; capture: boolean; expected?: TaskStep[]; truncated: boolean; finishing: boolean
}

export const WORKFLOW_HINT = `任务流程执行协议：
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
const empty = (): MemoryDocument => ({ version: 1, workflows: [], preferences: [] })
const MAX_FILE = 2 * 1024 * 1024

/** Never keep terminal output, stdin, keys, or live tab IDs in the reusable library. */
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

export const WORKFLOW_COMMANDS = ['model', 'new', 'resume', 'status', 'workflows', 'schedules', 'remember', 'help']
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
  return workflow.instructions || workflow.steps.map((step, i) => `${i + 1}. ${step.purpose || '执行操作'}${step.target ? `（此前终端：${step.target}）` : ''}\n   服务器与操作路径：${JSON.stringify(step.server || { identity: '旧流程未记录，执行前必须核实' })}\n   依赖步骤：${(step.dependsOn || []).join(', ') || '无'}\n   示例命令：${step.command}\n   验证命令：${(step.verificationCommands || []).join(' ; ')}\n   验收条件：${step.verification?.criteria || '执行前定义并确认'}\n   上次验收摘要（不能作为本次成功证据）：${step.verification?.evidence || '未记录'}`).join('\n')
}

function validTarget (value: any): boolean {
  return value && ['type', 'profileId', 'serverId', 'host', 'ip', 'username', 'cwd'].every(key => typeof value[key] === 'string') && Number.isInteger(value.port) && value.port >= 0 && value.port <= 65535
}

function validDocument (data: any): data is MemoryDocument {
  return data?.version === 1 && Array.isArray(data.workflows) && data.workflows.length <= 200 && Array.isArray(data.preferences) && data.preferences.length <= 100 &&
    data.workflows.every((w: any) => w && ['id', 'title', 'objective', 'cwd', 'instructions', 'outcome'].every(key => typeof w[key] === 'string') &&
      [w.completedAt, w.successes, w.uses].every(n => Number.isFinite(n) && n >= 0) && (w.alias === undefined || typeof w.alias === 'string') && typeof w.enabled === 'boolean' && typeof w.edited === 'boolean' &&
      Array.isArray(w.steps) && w.steps.length <= 24 && w.steps.every((s: any) => s && ['purpose', 'command', 'target'].every(key => typeof s[key] === 'string') &&
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
  constructor (private root: string) { this.file = path.join(root, 'task-memory.json') }
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
  constructor (readonly store: TaskMemoryStore) {}
  token (owner: string): string | undefined { return this.runs.get(owner)?.token }
  clearRuns (): void { this.runs.clear() }
  forgetRun (owner: string): void { this.runs.delete(owner) }
  async prepare (owner: string, objective: string, cwd: string, newGoal = false): Promise<MemorySuggestion> {
    // Only sanitized task text is kept in the capture buffer, too.
    if (newGoal) this.runs.set(owner, { token: id(), objective: redactMemory(objective, 1000), cwd, steps: [], reads: 0, verifiedSteps: 0, targets: {}, stepTabs: [], observations: {}, serial: 0, lastCommand: 0, inFlight: false, capture: true, truncated: false, finishing: false })
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
    this.runs.set(owner, { token: id(), objective: workflow.objective, cwd: workflow.cwd, steps: [], reads: 0, verifiedSteps: 0,
      targets: {}, stepTabs: [], observations: {}, serial: 0, lastCommand: 0, inFlight: false, capture: false, expected: workflow.steps,
      truncated: false, finishing: false })
  }
  executionContext (owner: string): string {
    const run = this.runs.get(owner)
    if (!run) return ''
    const pending = run.steps[run.steps.length - 1]
    return WORKFLOW_HINT + '\n当前流程数据（上次证据不能代替本次验收）：' + JSON.stringify({
      objective: run.objective, orderedSteps: run.expected || [],
      confirmedSteps: run.steps.map((s, i) => s.verification ? i + 1 : 0).filter(Boolean),
      pendingStep: pending && !pending.verification ? { number: run.steps.length, runtimeTabId: run.stepTabs[run.steps.length - 1], ...pending } : undefined,
      nextStep: pending && !pending.verification ? run.steps.length : run.steps.length + 1,
    })
  }
  beforeTool (owner: string, token: string | undefined, name: string, args: any): void {
    const run = this.runs.get(owner)
    if (!run || run.token !== token || name !== 'send_input' || args?.mode === 'stdin' || args?.submit !== true) return
    if (run.inFlight) throw new Error('上一条流程命令仍在发送，不能并行提交下一步骤')
    const reserve = () => { run.inFlight = true }
    const pending = run.steps[run.steps.length - 1]
    if (args.verificationFor !== undefined) {
      if (args.verificationFor === 0 && (!pending || pending.verification)) { reserve(); return }
      if (!pending || pending.verification || args.verificationFor !== run.steps.length || run.stepTabs[run.steps.length - 1] !== args.tabId) throw new Error('检查命令必须指向当前未确认步骤及其执行终端')
      reserve()
      return
    }
    if (pending && !pending.verification) throw new Error(`步骤 ${run.steps.length} 尚未确认完成；先读取该终端结果并调用 workflow_checkpoint，不能执行下一步`)
    if (run.expected?.length && run.steps.length >= run.expected.length) throw new Error('已完成流程中的所有步骤，不能追加未定义操作')
    const expected = run.expected?.[run.steps.length]?.server
    if (expected) {
      const current = run.targets[args.tabId]?.server
      const error = targetError(current)
      if (error) throw new Error(error)
      if (!sameTarget(current!, expected)) throw new Error('服务器身份或操作路径与流程下一步骤不一致；停止并核对目标，不能在其他服务器或路径执行')
    }
    reserve()
  }
  toolFailed (owner: string, token: string | undefined, name: string): void {
    const run = this.runs.get(owner)
    if (run && run.token === token && name === 'send_input') run.inFlight = false
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
      return { bound: true, server, nextStep: run.steps.length + 1 }
    }
    if (args.action && args.action !== 'confirm_step') throw new Error('未知流程确认操作')
    const index = run.steps.length - 1
    const step = run.steps[index]
    if (!step || args.step !== index + 1 || run.stepTabs[index] !== args.tabId || step.verification) throw new Error('只能确认当前未完成步骤，且必须读取其实际执行终端')
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
    run.verifiedSteps = run.steps.filter(s => s.verification).length
    return { confirmed: true, step: index + 1, nextStep: index + 2, server }
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
      run.observations[args.tabId] = { serial: run.serial, running: result.commandState === 'running' || result.commandState !== 'prompt' && !!result.runningProcesses?.length }
      return
    }
    if (name === 'send_input') run.inFlight = false
    if (name !== 'send_input' || !result?.sent) return
    if (args?.mode === 'stdin') { run.truncated = true; return }
    if (args?.submit !== true || result?.submitted !== true || typeof args.text !== 'string') return
    run.lastCommand = run.serial
    if (args.verificationFor === 0) return
    if (args.text.length > 1200) { run.truncated = true; return }
    const command = redactMemory(args.text, 1200)
    if (command.includes('[已隐藏') || /(?:^|[\s/])(?:passwd|sshpass)\b|(?:^|\s)(?:read\s+-s|export\s+.*(?:KEY|TOKEN|SECRET))/i.test(command)) { run.truncated = true; return }
    if (args.verificationFor !== undefined) {
      const step = run.steps[run.steps.length - 1]
      if (!step || args.verificationFor !== run.steps.length || run.stepTabs[run.steps.length - 1] !== args.tabId) { run.truncated = true; return }
      const checks = step.verificationCommands || (step.verificationCommands = [])
      if (checks.length >= 12) run.truncated = true
      else checks.push(command)
      return
    }
    if (run.steps.length >= 24) { run.truncated = true; return }
    const previous = run.steps[run.steps.length - 1]
    if (previous && !previous.verification) run.truncated = true
    const target = run.targets[args.tabId]
    const step: TaskStep = { command, purpose: redactMemory(args.purpose || '执行并检查结果', 180), target: target?.title || '',
      server: target?.server || cleanTarget(result.server), dependsOn: run.steps.length ? [run.steps.length] : [] }
    run.steps.push(step)
    run.stepTabs.push(args.tabId)
  }
  completionIssue (owner: string, token: string | undefined): string {
    const run = this.runs.get(owner)
    if (!run || run.token !== token) return ''
    if (run.inFlight || run.steps.some(s => !s.verification)) return '流程还有步骤未经实际结果验收，不能确认任务完成'
    if (run.expected?.length && run.steps.length !== run.expected.length) return '流程还有依赖步骤尚未执行，不能确认任务完成'
    return ''
  }
  async finish (owner: string, token: string | undefined, turnStatus: string, goalStatus: string, outcome: string): Promise<TaskWorkflow | undefined> {
    const run = this.runs.get(owner)
    if (!run || run.token !== token || run.finishing || turnStatus !== 'completed' || goalStatus !== 'complete') return undefined
    if (this.completionIssue(owner, token)) return undefined
    if (!run.capture) { this.runs.delete(owner); return undefined }
    if (!run.steps.length || !run.reads || run.verifiedSteps !== run.steps.length || run.steps.some(s => !s.verification || targetError(s.server)) || run.truncated) { this.runs.delete(owner); return undefined }
    run.finishing = true
    try {
      return await this.store.update(data => {
        const existing = data.workflows.find(w => w.cwd === run.cwd && w.objective === run.objective)
        if (existing) {
          existing.successes++
          existing.completedAt = Date.now()
          if (!existing.edited) { existing.steps = run.steps; existing.outcome = redactMemory(outcome, 800) }
          return existing
        }
        if (data.workflows.length >= 200) throw new Error('任务流程库已满（200 条），请先清理不再使用的流程')
        const workflow: TaskWorkflow = { id: id(), title: run.objective.slice(0, 80), objective: run.objective, cwd: run.cwd, steps: run.steps,
          instructions: '', outcome: redactMemory(outcome, 800), completedAt: Date.now(), successes: 1, uses: 0, enabled: true, edited: false }
        data.workflows.unshift(workflow)
        return workflow
      })
    } finally { if (this.runs.get(owner) === run) this.runs.delete(owner) }
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
  async saveWorkflow (workflow: TaskWorkflow, title: string, objective: string, instructions: string, enabled: boolean, alias = workflow.alias || ''): Promise<void> {
    const normalized = alias.trim() ? normalizeAlias(alias) : ''
    if (!title.trim() || !objective.trim() || !instructions.trim()) throw new Error('请填写流程名称、匹配任务和步骤')
    await this.store.update(data => {
      const current = data.workflows.find(w => w.id === workflow.id)
      if (!current) throw new Error('流程已被删除，请刷新列表')
      if (normalized && data.workflows.some(w => w.id !== workflow.id && w.cwd === current.cwd && w.alias === normalized)) throw new Error('当前目录已使用此别名')
      Object.assign(current, { alias: normalized, title: redactMemory(title.trim(), 120), objective: redactMemory(objective.trim(), 1000), instructions: redactMemory(instructions.trim(), 6000), enabled, edited: true })
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
