import { promises as fs } from 'fs'
import * as path from 'path'
import { randomBytes } from 'crypto'

export interface TaskStep { purpose: string; command: string; target: string }
export interface TaskWorkflow {
  id: string; title: string; objective: string; cwd: string; steps: TaskStep[]; instructions: string
  outcome: string; completedAt: number; successes: number; uses: number; enabled: boolean; edited: boolean
}
export interface TaskPreference { id: string; text: string; cwd: string }
export interface MemoryDocument { version: 1; workflows: TaskWorkflow[]; preferences: TaskPreference[] }
export interface MemorySuggestion { workflow?: TaskWorkflow; preferences: TaskPreference[]; context: string }
interface TaskRun { token: string; cwd: string; objective: string; steps: TaskStep[]; reads: number; verifiedSteps: number; targets: Record<string, string>; truncated: boolean; finishing: boolean }
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

function tokens (text: string): Set<string> {
  const normalized = text.normalize('NFKC').toLowerCase().replace(/(?:请帮我|帮我|麻烦|please|could you)/g, '')
    .replace(/构建|编译|打包|\b(?:build|compile)\b/g, ' __intent_build ')
    .replace(/部署|发布|\bdeploy\b/g, ' __intent_deploy ')
    .replace(/重新启动|重启|\brestart\b/g, ' __intent_restart ')
    .replace(/查看日志|检查日志|\blogs\b/g, ' __intent_logs ')
    .replace(/删除|移除|销毁|清理|\b(?:delete|remove)\b/g, ' __intent_delete ')
    .replace(/停止|停掉|\bstop\b/g, ' __intent_stop ')
    .replace(/启动|\bstart\b/g, ' __intent_start ')
  const words: string[] = normalized.match(/[a-z0-9_./-]{2,}/g) || []
  for (const part of normalized.match(/[\u3400-\u9fff]+/g) || []) {
    if (part.length === 1) words.push(part)
    else for (let i = 0; i < part.length - 1; i++) words.push(part.slice(i, i + 2))
  }
  return new Set(words)
}
export function matchWorkflow (workflows: TaskWorkflow[], query: string, cwd: string): TaskWorkflow | undefined {
  const negatedAction = /(?:不要|禁止|切勿|无需|不再|避免|别|不)\s*(?:重启|重新启动|启动|停止|删除|移除|部署|发布|构建|编译)|\b(?:do not|don't|never|without)\s+(?:restart|start|stop|delete|remove|deploy|build)\b/i
  if (negatedAction.test(query)) return undefined
  const queryTokens = tokens(query)
  if (!queryTokens.size) return undefined
  let best: TaskWorkflow | undefined, bestScore = 0
  for (const workflow of workflows) {
    if (!workflow.enabled || workflow.cwd !== cwd || negatedAction.test(workflow.objective)) continue
    const terms = tokens(workflow.objective)
    const queryActions = [...queryTokens].filter(term => term.startsWith('__intent_'))
    const workflowActions = [...terms].filter(term => term.startsWith('__intent_'))
    if (queryActions.length || workflowActions.length) {
      if (queryActions.length !== workflowActions.length || queryActions.some(action => !terms.has(action))) continue
    }
    const overlap = [...queryTokens].filter(term => terms.has(term)).length
    const coverage = overlap / queryTokens.size
    const dice = 2 * overlap / (queryTokens.size + terms.size)
    // Matching is conservative and advisory: even a close match never executes a command.
    if (coverage < .6 || dice < .55 || overlap < 2 && query.trim() !== workflow.objective.trim()) continue
    const score = dice + Math.min(workflow.successes, 10) * .002
    if (score > bestScore || score === bestScore && workflow.completedAt > (best?.completedAt || 0)) { best = workflow; bestScore = score }
  }
  return best
}
export function workflowInstructions (workflow: TaskWorkflow): string {
  return workflow.instructions || workflow.steps.map((step, i) => `${i + 1}. ${step.purpose || '执行操作'}${step.target ? `（此前终端：${step.target}）` : ''}\n   示例命令：${step.command}`).join('\n')
}

function validDocument (data: any): data is MemoryDocument {
  return data?.version === 1 && Array.isArray(data.workflows) && data.workflows.length <= 200 && Array.isArray(data.preferences) && data.preferences.length <= 100 &&
    data.workflows.every((w: any) => w && ['id', 'title', 'objective', 'cwd', 'instructions', 'outcome'].every(key => typeof w[key] === 'string') &&
      [w.completedAt, w.successes, w.uses].every(n => Number.isFinite(n) && n >= 0) && typeof w.enabled === 'boolean' && typeof w.edited === 'boolean' &&
      Array.isArray(w.steps) && w.steps.length <= 24 && w.steps.every((s: any) => s && ['purpose', 'command', 'target'].every(key => typeof s[key] === 'string'))) &&
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
  async prepare (owner: string, objective: string, cwd: string, newGoal = true): Promise<MemorySuggestion> {
    // Only sanitized task text is kept in the capture buffer, too.
    if (newGoal) this.runs.set(owner, { token: id(), objective: redactMemory(objective, 1000), cwd, steps: [], reads: 0, verifiedSteps: 0, targets: {}, truncated: false, finishing: false })
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
  record (owner: string, token: string | undefined, name: string, args: any, result: any): void {
    const run = this.runs.get(owner)
    if (!run || run.token !== token || run.finishing) return
    if (name === 'read_tab' && typeof result?.text === 'string') {
      run.reads++
      run.verifiedSteps = run.steps.length
      if (typeof result.title === 'string') run.targets[args.tabId] = redactMemory(result.title, 100)
      return
    }
    if (name !== 'send_input' || !result?.sent) return
    if (args?.mode === 'stdin') { run.truncated = true; return }
    if (args?.submit !== true || result?.submitted !== true || typeof args.text !== 'string') return
    if (args.text.length > 1200) { run.truncated = true; return }
    const command = redactMemory(args.text, 1200)
    // Secret-bearing commands are omitted entirely, including their parameter values.
    if (command.includes('[已隐藏') || /(?:^|[\s/])(?:passwd|sshpass)\b|(?:^|\s)(?:read\s+-s|export\s+.*(?:KEY|TOKEN|SECRET))/i.test(command)) { run.truncated = true; return }
    const step = { command, purpose: redactMemory(args.purpose || '执行并检查结果', 180), target: run.targets[args.tabId] || '' }
    const previous = run.steps[run.steps.length - 1]
    if (previous?.command === command) return
    if (run.steps.length >= 24) { run.truncated = true; return }
    run.steps.push(step)
  }
  async finish (owner: string, token: string | undefined, turnStatus: string, goalStatus: string, outcome: string): Promise<TaskWorkflow | undefined> {
    const run = this.runs.get(owner)
    if (!run || run.token !== token || run.finishing || turnStatus !== 'completed' || goalStatus !== 'complete') return undefined
    if (!run.steps.length || !run.reads || run.verifiedSteps !== run.steps.length || run.truncated) { this.runs.delete(owner); return undefined }
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
  async saveWorkflow (workflow: TaskWorkflow, title: string, objective: string, instructions: string, enabled: boolean): Promise<void> {
    if (!title.trim() || !objective.trim() || !instructions.trim()) throw new Error('请填写流程名称、匹配任务和步骤')
    await this.store.update(data => {
      const current = data.workflows.find(w => w.id === workflow.id)
      if (!current) throw new Error('流程已被删除，请刷新列表')
      Object.assign(current, { title: redactMemory(title.trim(), 120), objective: redactMemory(objective.trim(), 1000), instructions: redactMemory(instructions.trim(), 6000), enabled, edited: true })
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
