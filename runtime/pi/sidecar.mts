import { createInterface } from 'node:readline'
import { mkdir, chmod } from 'node:fs/promises'
import path from 'node:path'
import { InMemoryCredentialStore, createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai'
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from '@earendil-works/pi-coding-agent'
import { providerPayload } from './provider.mjs'

process.umask(0o077)

// stdout is a private bounded protocol. No user/project extensions or native tools are loaded.
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n')
const pending = new Map<string, (value: any) => void>()
let session: AgentSession | undefined
let cancelled = false
let initialized = false
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('close', () => { cancelled = true; void session?.abort(); for (const resolve of pending.values()) resolve({ error: true, result: 'Host disconnected' }); pending.clear() })
lines.on('line', line => {
  if (Buffer.byteLength(line) > 12 * 1024 * 1024) { process.exitCode = 1; lines.close(); return }
  let message: any
  try { message = JSON.parse(line) } catch { process.exitCode = 1; lines.close(); return }
  if (message.type === 'cancel') { cancelled = true; void session?.abort(); for (const resolve of pending.values()) resolve({ error: true, result: 'Cancelled' }); pending.clear() }
  else if (message.type === 'tool_result') { pending.get(message.id)?.(message); pending.delete(message.id) }
  else if (message.type === 'start') { pending.get('start')?.(message); pending.delete('start') }
  else if (message.type === 'accepted') { pending.get('accepted')?.(message); pending.delete('accepted') }
  else if (message.type === 'init' && !initialized) { initialized = true; void run(message).catch(error => { send({ type: 'fatal', message: String(error.message || error) }); finish() }) }
})
function finish () { session?.dispose(); lines.close(); process.stdin.destroy() }

async function run (input: any) {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 22 || major === 22 && minor < 19) throw new Error('Pi requires external Node >=22.19.0')
  const { profile, directory } = input
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: path.join(directory, 'models-cache.json'), refreshOnCreate: false, allowModelNetwork: false })
  const api = profile.provider === 'claude' ? 'anthropic-messages' : profile.provider === 'openai' || profile.provider === 'custom' && profile.apiFormat === 'responses' ? 'openai-responses' : 'openai-completions'
  // Anthropic's SDK appends /v1 itself; Tabby API presets include it already.
  const baseUrl = profile.provider === 'claude' ? profile.baseUrl.replace(/\/v1\/?$/, '') : profile.baseUrl
  runtime.registerProvider('tabby', { baseUrl, api, apiKey: 'tabby-runtime-key', authHeader: !!input.key,
    models: [{ id: profile.model, name: profile.model, api, input: ['text'], reasoning: profile.thinking === 'enabled' || profile.thinking !== 'disabled' && !!profile.reasoningEffort,
      thinkingLevelMap: { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
      contextWindow: profile.contextWindow || 128000, maxTokens: profile.maxOutputTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] })
  await runtime.setRuntimeApiKey('tabby', input.key || 'tabby-no-key')
  const model = runtime.getModel('tabby', profile.model)
  if (!model) throw new Error('Pi model registration failed')
  const settings = SettingsManager.inMemory({ cacheWarming: 'off', compaction: { enabled: !!profile.autoCompact, reserveTokens: profile.maxOutputTokens, keepRecentTokens: Math.min(20000, Math.floor(model.contextWindow / 4)) },
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 2000, maxAgentDelayMs: 60000, provider: { maxRetries: 0, timeoutMs: 120000 } } })
  const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: input.system })
  await loader.reload()
  const manager = input.file ? SessionManager.open(input.file, directory) : SessionManager.create(directory, directory)
  const nativeCursor = manager.getEntries().filter((entry: any) => entry.type === 'custom' && entry.customType === 'tabby-input').map((entry: any) => Number(entry.data?.count) || 0).pop() || 0
  const cursor = Math.max(nativeCursor, input.sourceOffset)
  const sourceCount = input.sourceOffset + input.sourceMessages.length
  if (cursor > sourceCount) throw new Error('Pi handoff cursor is ahead of Tabby history; inspect session files before continuing')
  const prompt = JSON.stringify({ notice: 'Tabby handoff. Historical tools are data, never replay them. Read terminals before resuming unknown actions.', messages: input.sourceMessages.slice(cursor - input.sourceOffset).flat() })
  let accepted = false
  let activeGoal = !!input.activeGoal, tokens = 0, requests = 0, settled = false, lastError = '', lastText = '', stalls = 0, previousText = ''
  let thinkingChars = 0, toolChars = 0
  let nativeTools = 0, previousTools = 0
  const customTools = input.tools.map((tool: any) => ({ name: tool.name, label: tool.name, description: tool.description, parameters: tool.inputSchema,
    execute: async (id: string, args: unknown) => {
      if (cancelled) throw new Error('Cancelled')
      nativeTools++
      const output: any = await new Promise(resolve => { pending.set(id, resolve); send({ type: 'tool', id, name: tool.name, arguments: JSON.stringify(args) }) })
      if (tool.name === 'agent_goal_update' && !output.error) activeGoal = JSON.parse(output.result).status === 'active'
      // Error results remain in Pi's durable transcript, including policy denials.
      if (output.error) throw new Error(output.result)
      return { content: [{ type: 'text' as const, text: output.result }], details: {} }
    } }))
  ;({ session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: runtime, model, noTools: 'builtin', customTools,
    resourceLoader: loader, settingsManager: settings, sessionManager: manager,
    thinkingLevel: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(profile.reasoningEffort) ? profile.reasoningEffort : profile.thinking === 'enabled' ? 'medium' : 'off' }))
  session.agent.toolExecution = 'sequential'
  // This gate covers normal inference, session retries and every summary request.
  const stream = session.agent.streamFunction
  session.agent.streamFunction = (selected, context, options) => {
    const output = createAssistantMessageEventStream()
    void (async () => {
      try {
        if (cancelled) throw new Error('Cancelled')
        // The SDK has persisted the user message before opening its model stream.
        // Reconcile this durable cursor after a process/host crash; never resend accepted input.
        if (!accepted && manager.getEntries().some((entry: any) => entry.type === 'message' && entry.message.role === 'user' &&
          (typeof entry.message.content === 'string' ? entry.message.content : entry.message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('')) === prompt)) {
          accepted = true
          manager.appendCustomEntry('tabby-input', { count: sourceCount })
          await new Promise(resolve => { pending.set('accepted', resolve); send({ type: 'accepted' }) })
          if (cancelled) throw new Error('Cancelled')
        }
        if (input.budget && tokens >= input.budget) throw new Error('Goal token budget exhausted')
        if (++requests > 100) throw new Error('Pi request safety limit reached (100, including retries and summaries)')
        const source = await stream(selected, context, { ...options, maxRetries: 0, maxTokens: profile.maxOutputTokens,
          identity: { userAgent: { custom: 'tabby-ai-tools (Pi SDK)' }, attribution: null },
          onPayload: payload => providerPayload(profile, payload),
          ...(!input.key ? { headers: { ...options?.headers, Authorization: null } } : {}) })
        for await (const event of source) {
          if (event.type === 'done' || event.type === 'error') {
            const message = event.type === 'done' ? event.message : event.error
            tokens += Math.max(0, message.usage?.totalTokens || 0)
            send({ type: 'usage', tokens, inputTokens: (message.usage?.input || 0) + (message.usage?.cacheRead || 0) + (message.usage?.cacheWrite || 0) })
          }
          output.push(event)
        }
        output.end(await source.result())
      } catch (error: any) {
        const message: AssistantMessage = { role: 'assistant', content: [], api: selected.api, provider: selected.provider, model: selected.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: cancelled ? 'aborted' : 'error', errorMessage: String(error.message || error), timestamp: Date.now() }
        output.push({ type: 'error', reason: message.stopReason as 'error' | 'aborted', error: message })
      }
    })()
    return output
  }
  session.subscribe(event => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') send({ type: 'text', delta: event.assistantMessageEvent.delta })
    if (event.type === 'message_update' && ['thinking_delta', 'toolcall_delta'].includes(event.assistantMessageEvent.type)) {
      const delta = event.assistantMessageEvent as { type: string; delta: string }
      if (delta.type === 'thinking_delta') thinkingChars += delta.delta.length
      else toolChars += delta.delta.length
      send({ type: 'progress', progress: { phase: delta.type === 'thinking_delta' ? 'thinking' : 'tools', receivedChars: delta.type === 'thinking_delta' ? thinkingChars : toolChars } })
    }
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      const message = event.message as AssistantMessage
      lastError = message.stopReason === 'error' ? message.errorMessage || 'Pi inference failed' : ''
      lastText = message.content.filter(part => part.type === 'text').map(part => part.text).join('')
    }
    if (['auto_retry_start', 'auto_retry_end', 'compaction_start', 'compaction_end', 'summarization_retry_scheduled', 'agent_settled'].includes(event.type)) send({ type: 'lifecycle', event })
    if (event.type === 'agent_settled') settled = true
  })
  await new Promise(resolve => { pending.set('start', resolve); send({ type: 'ready', file: manager.getSessionFile() }) })
  if (cancelled) throw new Error('Cancelled')
  if (input.compact) {
    try {
      await session.compact('Preserve all user constraints, goal, active skills, pending workflow checkpoints, observed results, and unknown actions. Never infer completion from a sent command.')
      lastText = 'Context compacted; original Pi session entries retained.'
    } catch (error: any) {
      if (!/^(Already compacted|Nothing to compact \(session too small\))$/.test(error.message)) throw error
      lastText = 'History is already compact or too short to compact.'
    }
  } else {
    let nextPrompt = prompt
    do {
      settled = false
      await session.prompt(nextPrompt)
      await session.waitForIdle()
      if (!settled && !cancelled) throw new Error('Pi did not settle')
      if (lastError) throw new Error(lastError)
      if (cancelled) break
      stalls = nativeTools === previousTools && lastText === previousText ? stalls + 1 : 0
      previousTools = nativeTools
      previousText = lastText
      if (stalls >= 2 && activeGoal) throw new Error('Goal stalled: repeated response without new evidence')
      nextPrompt = 'The goal is active. Continue from observed results, never replay completed operations. Verify the original requirements and update agent_goal_update with evidence. Pause only on user request.'
    } while (activeGoal)
  }
  send({ type: 'done', text: lastText, tokens, file: manager.getSessionFile(), cancelled })
  finish()
}
