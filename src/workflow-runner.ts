import { TaskMemory, WorkflowTarget, observationFingerprint } from './task-memory'
import { WorkflowInteraction, WorkflowObservation, matchesConditions, WorkflowResponse } from './workflow-policy'
import type { WorkflowDecision } from './workflow-decision'
import { matchesProcess } from './terminal-keys'

export interface WorkflowRunnerPorts {
  signal: AbortSignal
  call: (name: string, args: any) => Promise<any>
  decide: (input: { objective: string; node: WorkflowInteraction; observationId: string; observation: WorkflowObservation }) => Promise<WorkflowDecision>
  persist?: () => Promise<void>
}
export interface WorkflowRunResult { status: 'complete' | 'needs_model' | 'needs_attention' | 'awaiting_verification' | 'waiting' | 'bind_target'; step?: number; reason: string; target?: WorkflowTarget; observation?: WorkflowObservation }

/** Keep only newly appended lines; a previous success message is not current proof. */
function newOutput (before: string, after: string): string {
  const oldLines = before.split(/\r?\n/), newLines = after.split(/\r?\n/)
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++
  if (prefix) return newLines.slice(prefix).join('\n')
  for (let overlap = Math.min(oldLines.length, newLines.length); overlap > 0; overlap--) {
    if (oldLines.slice(-overlap).join('\n') === newLines.slice(0, overlap).join('\n')) return newLines.slice(overlap).join('\n')
  }
  // A redrawn screen has no reliable output boundary.
  return ''
}

/** Host interpreter for saved conditions and interactions; it never evaluates code. */
export class WorkflowRunner {
  constructor (private memory: TaskMemory) {}
  private check (ports: WorkflowRunnerPorts): void { if (ports.signal.aborted) throw new Error('流程运行已停止；先检查终端再续接') }
  private async read (tabId: string, ports: WorkflowRunnerPorts, waitMs = 0): Promise<WorkflowObservation> {
    this.check(ports)
    const result = await ports.call('read_tab', { tabId, maxLines: 100, waitMs })
    this.check(ports)
    return result
  }
  private interactive (observation: WorkflowObservation, node: WorkflowInteraction): boolean {
    return observation.commandState !== 'prompt' && observation.controlledByAI === true && !!observation.runningProcesses?.length &&
      (!node.expectedProcess || matchesProcess(observation.runningProcesses, node.expectedProcess))
  }
  async interact (owner: string, token: string | undefined, tabId: string, ports: WorkflowRunnerPorts, interactionId?: string): Promise<WorkflowRunResult> {
    const release = this.memory.claimRunner(owner, token)
    try { return await this.handleInteraction(owner, token, tabId, ports, interactionId) } finally { release() }
  }
  private async handleInteraction (owner: string, token: string | undefined, tabId: string, ports: WorkflowRunnerPorts, interactionId?: string): Promise<WorkflowRunResult> {
    const observation = await this.read(tabId, ports)
    const state = this.memory.runtime(owner, token, tabId)
    if (state.uncertain) return { status: 'needs_model', reason: '上一动作结果未知，先核对现场并 resolve_action，不能重复回答' }
    if (!state.pending || state.pendingTab !== tabId) return { status: 'needs_model', reason: '当前没有此终端的待验收步骤' }
    const nodes: WorkflowInteraction[] = state.pending.policy?.interactions || []
    const node = interactionId ? nodes.find(n => n.id === interactionId) : nodes.find(n => n.rules.some(r => matchesConditions(r.when, observation))) || nodes[0]
    if (!node) return { status: 'needs_model', step: state.number, reason: '当前交互没有保存策略；主模型处理后用 workflow_configure 补充录制策略' }
    if (node.mode === 'manual') return { status: 'needs_attention', step: state.number, reason: node.intent }
    if (!this.interactive(observation, node)) return { status: 'needs_model', step: state.number, reason: '无法证明当前受控交互进程仍在运行；已保留续接点', observation }
    const fingerprint = observationFingerprint(observation)
    const rule = node.rules.find(r => matchesConditions(r.when, observation))
    let response: WorkflowResponse | undefined = rule?.response
    if (!response) {
      let decision: WorkflowDecision
      try { decision = await ports.decide({ objective: state.objective, node, observationId: fingerprint, observation }) }
      catch (error: any) {
        this.check(ports)
        return { status: 'needs_model', step: state.number, reason: String(error.message || error) }
      }
      this.check(ports)
      if (decision.nodeId !== node.id || decision.observationId !== fingerprint) return { status: 'needs_model', step: state.number, reason: '辅助决策与当前节点或观察不一致' }
      if (decision.action !== 'respond') return { status: decision.action === 'needs_attention' ? 'needs_attention' : decision.action === 'wait' ? 'waiting' : 'needs_model', step: state.number, reason: decision.reason }
      response = decision.response
    }
    if (!response) return { status: 'needs_model', step: state.number, reason: '没有有效交互动作' }
    // A decision may have taken seconds. Re-read instead of sending into a vanished prompt.
    const current = await this.read(tabId, ports)
    if (observationFingerprint(current) !== fingerprint || !this.interactive(current, node)) return { status: 'needs_model', step: state.number, reason: '交互现场已经变化，已丢弃旧回答', observation: current }
    this.memory.assertObservation(owner, token, tabId, fingerprint)
    this.check(ports)
    // Persist an unknown-result receipt before a potentially irreversible terminal write.
    await ports.persist?.()
    const args = response.kind === 'answer' ? { tabId, mode: 'stdin', text: response.text, submit: true, purpose: node.intent, expectedObservation: fingerprint }
      : { tabId, key: response.key, shift: response.shift, alt: response.alt, ctrl: response.ctrl, expectedObservation: fingerprint }
    await ports.call(response.kind === 'answer' ? 'send_input' : 'send_keys', args)
    await ports.persist?.()
    const next = await this.read(tabId, ports, 1000)
    return { status: next.commandState === 'prompt' ? 'awaiting_verification' : 'waiting', step: state.number,
      reason: '已处理当前交互并读取新结果；逻辑步骤仍需验收', observation: next }
  }
  async run (owner: string, token: string | undefined, tabId: string, ports: WorkflowRunnerPorts): Promise<WorkflowRunResult> {
    const release = this.memory.claimRunner(owner, token)
    try {
      // One call has bounded work. Calling again resumes the existing pending step.
      for (let operations = 0; operations < 24; operations++) {
        this.check(ports)
        let state = this.memory.runtime(owner, token, tabId)
        if (state.uncertain) return { status: 'needs_model', step: state.number, reason: '上一动作结果未知，先读现场并 resolve_action，禁止自动重发' }
        if (state.capture) return { status: 'needs_model', reason: '录制中由主模型执行并保存规则；运行器用于已保存别名' }
        if (state.complete) return { status: 'complete', reason: '所选路径的全部步骤已验收；请核对任务最终目标' }
        let observation = await this.read(tabId, ports)
        state = this.memory.runtime(owner, token, tabId)
        if (state.pending && state.pendingTab !== tabId) return { status: 'bind_target', step: state.number, target: state.pending.server, reason: '先绑定当前未验收步骤的实际终端' }
        const expected = state.expected
        if (!expected) return { status: 'needs_model', step: state.number, reason: '缺少保存的后续节点' }
        if (!state.pending) {
          if (expected.policy?.when) {
            if (observation.commandState !== 'prompt') return { status: 'needs_model', step: state.number, reason: '分支判断需要可靠的空闲 Shell 状态', observation }
            if (!matchesConditions(expected.policy.when, observation)) {
              this.memory.skipNext(owner, token, tabId)
              await ports.persist?.()
              continue
            }
          }
          if (expected.policy?.decision) return { status: 'needs_model', step: state.number, reason: `此步骤需要 AI 决策：${expected.policy.decision}。请根据当前现场判断并用 send_input 提交本逻辑步骤，再从当前节点继续 workflow_run；不要重放前序操作。`, observation }
          if (!expected.command) return { status: 'needs_model', step: state.number, reason: '此节点需要接管现有进程；先现场核对并 attach_process' }
          await ports.persist?.()
          const sent = await ports.call('send_input', { tabId, text: expected.command, submit: true, purpose: expected.purpose, foregroundTaskNeeded: true })
          if (!sent?.sent) return { status: 'needs_model', step: state.number, reason: sent?.reason || '命令未发送；先处理当前终端状态' }
          await ports.persist?.()
          observation = await this.read(tabId, ports, 1000)
        }
        if (observation.commandState !== 'prompt') {
          if (expected.policy?.interactions?.length) {
            const result = await this.handleInteraction(owner, token, tabId, ports)
            if (result.status !== 'awaiting_verification' || !result.observation) return result
            observation = result.observation
          } else return { status: 'waiting', step: state.number, reason: '命令尚未可靠结束；保留当前步骤，下一次继续观察', observation }
        }
        if (observation.commandState !== 'prompt') return { status: 'awaiting_verification', step: state.number, reason: '需要主模型根据实际结果验收', observation }
        if (!expected.policy?.verify || !expected.verification?.criteria) return { status: 'awaiting_verification', step: state.number, reason: '此步骤没有机器验收规则，请使用保存的 criteria 现场验收', observation }
        const verify = expected.policy.verify
        // Do not accept an echoed verification command as evidence for its own success.
        if (verify.expect.some(c => c.source !== 'commandState' && verify.command.includes(c.value))) return { status: 'awaiting_verification', step: state.number, reason: '验证条件可能命中命令回显，需要主模型核对', observation }
        const beforeVerify = observation.text
        const sent = await ports.call('send_input', { tabId, text: verify.command, submit: true, verificationFor: state.number })
        if (!sent?.sent) return { status: 'needs_model', step: state.number, reason: '验证命令未发送' }
        observation = await this.read(tabId, ports, 1000)
        if (observation.commandState !== 'prompt' || !matchesConditions(verify.expect, { ...observation, text: newOutput(beforeVerify, observation.text) })) return { status: 'awaiting_verification', step: state.number, reason: '自动验收条件未通过，后续依赖保持阻塞', observation }
        this.memory.checkpoint(owner, token, { action: 'confirm_step', tabId, step: state.number, criteria: expected.verification.criteria, evidence: '本次独立验证命令已结束，现场结果满足保存的条件：' + JSON.stringify(verify.expect) })
        await ports.persist?.()
        state = this.memory.runtime(owner, token, tabId)
        if (state.expected?.server && JSON.stringify(state.expected.server) !== JSON.stringify(expected.server)) return { status: 'bind_target', step: state.number, target: state.expected.server, reason: '下一步骤目标或路径变化，先重新核对绑定' }
      }
      return { status: 'waiting', reason: '本次运行器操作达到上限，从当前节点继续' }
    } finally { release() }
  }
}
