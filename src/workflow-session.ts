import type { AgentBackendFactory } from './agent-backend.service'
import type { AgentBackend } from './agent-types'
import type { AgentSettings } from './config'
import { TaskMemory, observationFingerprint } from './task-memory'
import { decideWorkflowInteraction } from './workflow-decision'
import { WorkflowRunner, WorkflowRunnerPorts } from './workflow-runner'

/** Bind a workflow runtime to one immutable connection/goal for the duration of a tool call. */
export async function runWorkflowTool (input: {
  name: string; args: any; owner: string; token: string | undefined; profileId: string; settings: AgentSettings
  backend: AgentBackend; factory: AgentBackendFactory; memory: TaskMemory; signal: AbortSignal
  call: (name: string, args: any) => Promise<any>; notice: (text: string) => void
}): Promise<any> {
  const { memory, owner, token, settings, signal } = input
  const configured = settings.workflowHelpers?.[input.profileId || 'codex']
  const current = input.backend.getThreadConfiguration?.(owner)
  const helper = { ...settings, model: configured?.model?.trim() || current?.model || settings.model,
    reasoningEffort: configured?.model?.trim() ? configured.reasoningEffort || '' : current?.reasoningEffort ?? settings.reasoningEffort }
  const remaining = async () => {
    if (signal.aborted || memory.token(owner) !== token) throw new Error('流程运行已停止或切换')
    const goal = await input.backend.getGoal(owner)
    const used = Number(goal?.tokensUsed ?? goal?.usedTokens ?? 0) + (input.backend.accountUsage ? 0 : memory.runtime(owner, token, input.args.tabId).helperTokens)
    const budget = Number(goal?.tokenBudget || settings.goalTokenBudget || 0)
    if (budget > 0 && used >= budget) throw new Error('已达到目标 token 预算；保留当前节点，未执行后续操作')
    return budget > 0 ? budget - used : 0
  }
  const ports: WorkflowRunnerPorts = {
    signal, persist: () => memory.persistRun(owner),
    call: async (name, args) => { await remaining(); return input.call(name, args) },
    decide: async state => {
      await remaining()
      memory.reserveDecision(owner, token, state.node.id + ':' + state.observationId, Math.max(1, Math.min(2, configured?.maxCalls || 2)))
      await memory.persistRun(owner)
      input.notice(`交互决策：${helper.model || '当前连接默认模型'}${configured?.model ? '' : '（未配置辅助模型，沿用当前模型）'}`)
      return decideWorkflowInteraction(s => input.factory.createDecision(input.profileId, s), helper, state, signal, async tokens => {
        memory.addHelperTokens(owner, token, tokens)
        await input.backend.accountUsage?.(owner, tokens)
        await memory.persistRun(owner)
        await remaining()
      }, Math.max(1000, Math.min(60000, configured?.timeoutMs || 15000)))
    },
  }
  const runner = new WorkflowRunner(memory)
  if (input.name === 'workflow_question') {
    const { question, policy } = input.args
    const state = memory.runtime(owner, token, '')
    const observation = { text: JSON.stringify({ question, previousChoice: policy.previousChoice }) }
    return ports.decide({ objective: state.objective, node: { id: policy.id, intent: policy.intent, mode: 'model', rules: [], observed: true }, observation,
      observationId: observationFingerprint(observation) })
  }
  const result = input.name === 'workflow_run' ? await runner.run(owner, token, input.args.tabId, ports)
    : await runner.interact(owner, token, input.args.tabId, ports, input.args.interactionId)
  input.notice(result.reason)
  return result
}
