import { randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ApiProviderAdapter, ToolDefinition } from './api-provider'
import { withAbort } from './api-transport'
import type { ApiProfile } from './agent-types'
import type { AgentSettings } from './config'
import { CodexClient } from './codex-client'
import { redactMemory } from './task-memory'

export interface ModelProbeResult {
  ok: boolean; model: string; reasoningEffort: string; testedAt: number; totalTokens: number; error?: string
}
export interface TaskModelCheck {
  requestedProfileId: string; requestedModel: string; requestedReasoningEffort: string
  selectedProfileId: string; selectedModel: string; selectedReasoningEffort: string
  testedAt: number; fallbackUsed: boolean; totalTokens: number; candidateError?: string
}
type ReportUsage = (totalTokens: number) => void
const knownTokens = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
function usageError (error: any, totalTokens: number): Error {
  const failure = error instanceof Error ? error : new Error(String(error))
  return Object.assign(failure, { totalTokens: Math.max(knownTokens(error?.totalTokens), knownTokens(totalTokens)) })
}

const definition = (nonce: string): ToolDefinition => ({ name: 'confirm', description: 'A harmless model readiness check. Call once with the requested nonce. No files or terminals are accessed.',
  inputSchema: { type: 'object', properties: { nonce: { type: 'string', enum: [nonce] } }, required: ['nonce'], additionalProperties: false } })
const prompt = (nonce: string) => `This is a model readiness test. Call the confirm tool exactly once with nonce ${nonce}. Do not use any other tools, read files or execute commands. After its result, reply OK.`

export async function probeApiModel (profile: ApiProfile, getKey: () => Promise<string>, signal: AbortSignal, reportUsage: ReportUsage = () => {}): Promise<number> {
  const nonce = randomBytes(8).toString('hex')
  const adapter = new ApiProviderAdapter({ ...profile, maxOutputTokens: Math.min(profile.maxOutputTokens || 4096, 4096) }, await withAbort(getKey(), signal))
  let totalTokens = 0
  const usage = (tokens: number) => { totalTokens = Math.max(totalTokens, knownTokens(tokens)); reportUsage(totalTokens) }
  try {
    const result = await adapter.generate([adapter.user(prompt(nonce))], 'Perform only the harmless model readiness check requested by the user.', [definition(nonce)], signal, () => {}, undefined, usage)
    usage(result.totalTokens)
    const call = result.tools[0]
    if (result.tools.length !== 1 || call?.name !== 'confirm' || JSON.parse(call.arguments)?.nonce !== nonce) throw new Error('模型未通过工具调用测试，未启用候选模型')
    return totalTokens
  } catch (error) { throw usageError(error, totalTokens) }
}

/** Independent ephemeral Codex session in an empty directory with read-only access. */
export async function probeCodexModel (settings: AgentSettings, signal: AbortSignal, client = new CodexClient(), reportUsage: ReportUsage = () => {}): Promise<number> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tabby-model-test-'))
  const nonce = randomBytes(8).toString('hex')
  let threadId = '', totalTokens = 0, confirmed = false
  let resolve!: () => void, reject!: (error: Error) => void
  const finished = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  void finished.catch(() => undefined)
  const onEvent = (event: any) => {
    if (!threadId || event.params?.threadId !== threadId) return
    const p = event.params
    if (event.id !== undefined) {
      try {
        const args = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : p.arguments
        if (event.method !== 'item/tool/call' || p.namespace !== 'tabby_model_test' || p.tool !== 'confirm' || args?.nonce !== nonce || confirmed) throw new Error('模型测试请求了测试范围以外的操作')
        confirmed = true
        client.respond(event.id, { success: true, contentItems: [{ type: 'inputText', text: 'OK' }] })
      } catch (error: any) { client.respondError(event.id, String(error.message)); reject(error) }
    }
    if (event.method === 'thread/tokenUsage/updated') {
      totalTokens = Math.max(totalTokens, knownTokens(p.tokenUsage?.total?.totalTokens))
      reportUsage(totalTokens)
    }
    if (event.method === 'item/started' && ['commandExecution', 'fileChange'].includes(p.item?.type)) reject(new Error('模型测试不允许执行命令或修改文件'))
    if (event.method === 'turn/completed') {
      if (p.turn.status !== 'completed' || !confirmed) reject(new Error(p.turn.error?.message || '模型未通过工具调用测试'))
      else resolve()
    }
  }
  const onDisconnect = (error: Error) => reject(error || new Error('模型测试连接中断'))
  client.on('event', onEvent); client.on('disconnected', onDisconnect)
  try {
    await withAbort(client.connect(settings.executable || 'codex'), signal)
    const started = await withAbort(client.request('thread/start', { cwd: directory, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only',
      ...(settings.model ? { model: settings.model } : {}),
      config: { 'features.shell_tool': false, 'features.apps': false, web_search: 'disabled', ...(settings.reasoningEffort ? { model_reasoning_effort: settings.reasoningEffort } : {}) },
      developerInstructions: 'This isolated session tests model readiness. Only call tabby_model_test.confirm. Do not access the filesystem, execute commands, create goals or call other tools.',
      dynamicTools: [{ type: 'namespace', name: 'tabby_model_test', description: 'Harmless isolated model readiness confirmation.', tools: [{ type: 'function', ...definition(nonce) }] }] }), signal)
    threadId = started.thread.id
    await withAbort(client.request('turn/start', { threadId, cwd: directory, input: [{ type: 'text', text: prompt(nonce) }], approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false }, ...(settings.model ? { model: settings.model } : {}), ...(settings.reasoningEffort ? { effort: settings.reasoningEffort } : {}) }), signal)
    await withAbort(finished, signal)
    return totalTokens
  } catch (error) { throw usageError(error, totalTokens) } finally {
    client.off('event', onEvent); client.off('disconnected', onDisconnect)
    client.close()
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function runModelProbe (settings: AgentSettings, operation: (signal: AbortSignal, reportUsage: ReportUsage) => Promise<number>, signal?: AbortSignal, timeoutMs = 60000): Promise<ModelProbeResult> {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()
  const timer = setTimeout(cancel, timeoutMs)
  const base = { model: settings.model, reasoningEffort: settings.reasoningEffort || '', testedAt: Date.now(), totalTokens: 0 }
  let reportedTokens = 0
  const reportUsage: ReportUsage = tokens => { reportedTokens = Math.max(reportedTokens, knownTokens(tokens)) }
  try {
    const totalTokens = await withAbort(operation(controller.signal, reportUsage), controller.signal)
    return { ...base, ok: true, totalTokens: Math.max(reportedTokens, knownTokens(totalTokens)) }
  } catch (error: any) {
    if (signal?.aborted) throw usageError(new Error('模型测试已取消'), Math.max(reportedTokens, knownTokens(error?.totalTokens)))
    return { ...base, totalTokens: Math.max(reportedTokens, knownTokens(error?.totalTokens)), ok: false, error: controller.signal.aborted ? '模型测试超过 60 秒，候选模型未启用' : redactMemory(String(error.message || error), 1000) }
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel) }
}
