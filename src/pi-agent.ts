import { spawn } from 'child_process'
import * as path from 'path'
import * as os from 'os'
import { randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import { ApiAgent } from './api-agent'
import { ApiProviderAdapter, ModelResult, ModelToolCall, StreamProgress, ToolDefinition, ToolResult } from './api-provider'
import { ApiProfile } from './agent-types'
import { AgentStore, ApiSession, agentId, profileFingerprint } from './agent-store'
import { AgentSettings } from './config'
import { portableMessages } from './agent-context'
import { resolveClaudeExecutable, runClaudeProcess } from './claude-code-client'
import { terminateCodexProcess } from './codex-process'
import { apiUrl, withAbort } from './api-transport'
import { apiPath } from './agent-types'
import { redactMemory } from './task-memory'
import { journaledToolCall } from './host-tool-bridge'

async function inspectPiNode (profile: ApiProfile, cwd: string, signal: AbortSignal): Promise<{ executable: string; version: string }> {
  let executable: string
  try { executable = resolveClaudeExecutable(profile.piNodeExecutable || 'node', { cwd }) }
  catch { throw new Error('找不到 Pi 所需的外部 Node；请安装 Node >=22.19 并设置可执行文件路径') }
  const version = (await runClaudeProcess({ executable, args: ['-p', 'process.versions.node'], cwd, signal, timeoutMs: 10000 })).trim()
  const [major, minor] = version.split('.').map(Number)
  if (!Number.isInteger(major) || major < 22 || major === 22 && minor < 19) throw new Error('Pi 需要外部 Node >=22.19.0；当前为 ' + version)
  return { executable, version }
}

/** No shell, HTTP transport retries, automatic process restart, or prompt replay. */
export async function runPiProcess (executable: string, input: any, signal: AbortSignal, onMessage: (message: any, send: (message: any) => void, signal: AbortSignal) => Promise<void>, sidecar = path.join(__dirname, '..', 'dist', 'pi', 'sidecar.mjs')): Promise<any> {
  if (signal.aborted) throw new Error('请求已停止')
  const child = spawn(executable, [sidecar], { stdio: 'pipe', shell: false, windowsHide: true, detached: process.platform !== 'win32',
    // Prevent Node loader options from injecting code into the isolated runtime.
    env: { ...process.env, NODE_OPTIONS: '', ELECTRON_RUN_AS_NODE: '' } })
  let closed = false, done: any, fatal: Error | undefined, buffer = '', bytes = 0
  let queue = Promise.resolve(), stopping: Promise<void> | undefined
  const bridge = new AbortController()
  const stop = () => stopping ||= terminateCodexProcess(child, { closed })
  const send = (message: any) => { if (!closed && !child.stdin.destroyed) child.stdin.write(JSON.stringify(message) + '\n') }
  const abort = () => { bridge.abort(); send({ type: 'cancel' }); void stop().catch(error => { fatal ||= error }) }
  const fail = (error: Error) => { bridge.abort(); fatal ||= error; void stop().catch(() => undefined) }
  signal.addEventListener('abort', abort, { once: true })
  child.stdin.on('error', error => { if (!closed && !signal.aborted && !done) fail(error) })
  child.stdout.on('error', fail)
  child.stderr.on('error', fail)
  // Dependency diagnostics are intentionally discarded: they may contain endpoint credentials.
  child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) fail(new Error('Pi stderr exceeded limit')) })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buffer += chunk
    if (Buffer.byteLength(buffer) > 12 * 1024 * 1024) { fail(new Error('Pi protocol exceeded limit')); return }
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
      queue = queue.then(async () => {
        const message = JSON.parse(line)
        if (message.type === 'fatal') throw new Error(message.message)
        if (message.type === 'done') { done = message; return }
        if (!bridge.signal.aborted) await onMessage(message, send, bridge.signal)
      }).catch(fail)
    }
  })
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, terminated) => {
        closed = true
        bridge.abort()
        void queue.then(() => {
          if (fatal) reject(fatal)
          else if (signal.aborted) reject(new Error('请求已停止'))
          else if (code || terminated || !done || buffer.trim()) reject(new Error('Pi 进程未正常结束；可能已有终端操作发生，请先核对状态'))
          else resolve()
        }, reject)
      })
      send({ type: 'init', ...input })
      if (signal.aborted) abort()
    })
    return done
  } finally {
    signal.removeEventListener('abort', abort)
    if (stopping) await stopping
    else if (!closed) await stop()
  }
}

export class PiAdapter extends ApiProviderAdapter {
  constructor (profile: ApiProfile, private executable: string, private session: ApiSession, private store: AgentStore,
    private getKey: () => Promise<string>, private call: (call: ModelToolCall, signal?: AbortSignal) => Promise<ToolResult>, private lifecycle: (event: any) => void) { super(profile, '') }

  async generate (messages: any[], system: string, tools: ToolDefinition[], signal: AbortSignal, onText: (text: string) => void, onProgress?: (progress: StreamProgress) => void, onUsage?: (tokens: number) => void): Promise<ModelResult> {
    apiUrl(this.profile.baseUrl, apiPath(this.profile))
    const directory = this.store.piDirectory(this.session.id)
    let prior = this.session.piSession
    if (prior && (path.dirname(prior.file) !== directory || !prior.file.endsWith('.jsonl'))) throw new Error('Pi 会话路径无效')
    if (prior && (!Number.isInteger(prior.messageCount) || prior.messageCount < 0 || prior.messageCount > messages.length)) throw new Error('Pi 会话上下文游标无效')
    if (prior) {
      try {
        if (!(await fs.stat(prior.file)).size) throw new Error('Pi native session is empty; inspect the history before continuing')
      } catch (error: any) {
        if (error.code === 'ENOENT' && !prior.messageCount && !Object.keys(this.session.actions || {}).length) {
          prior = undefined
          delete this.session.piSession
        } else throw new Error('Pi native session is missing or unreadable; inspect the saved transcript and terminal state before creating a new session')
      }
    }
    const compact = messages[messages.length - 1]?.content?.trim?.() === '/compact'
    if (compact && !prior) {
      const text = '历史较短，无需压缩。'
      onText(text)
      return { text, messages: [{ role: 'assistant', content: text }], tools: [], inputTokens: 0, outputTokens: 0, totalTokens: 0, usageReported: false, stop: 'end' }
    }
    const start = prior?.messageCount || 0
    const sourceMessages = messages.slice(start).map(message => portableMessages([message]))
    const key = await withAbort(this.getKey(), signal)
    const safe = (value: string) => redactMemory(key ? value.split(key).join('[redacted]') : value, 2000)
    let text = '', total = 0, inputTokens = 0
    const recorded: any[] = []
    const result = await runPiProcess(this.executable, { profile: { ...this.profile, apiKey: undefined, threads: undefined }, key, directory,
      file: prior?.file, system, tools, sourceMessages, sourceOffset: start, compact, activeGoal: this.session.goal?.status === 'active',
      budget: this.session.goal?.tokenBudget ? Math.max(1, this.session.goal.tokenBudget - this.session.goal.usedTokens) : 0 }, signal, async (message, send, bridgeSignal) => {
      if (message.type === 'ready') {
        if (path.dirname(message.file) !== directory || !message.file.endsWith('.jsonl')) throw new Error('Pi 返回了无效的会话路径')
        this.session.piSession = { file: message.file, messageCount: start }
        await this.store.save(this.session)
        send({ type: 'start' })
      } else if (message.type === 'accepted') {
        this.session.piSession!.messageCount = messages.length
        await this.store.save(this.session)
        send({ type: 'accepted' })
      } else if (message.type === 'text') { text += message.delta; onText(message.delta) }
      else if (message.type === 'usage') { total = message.tokens; inputTokens = message.inputTokens; onUsage?.(total) }
      else if (message.type === 'progress') onProgress?.(message.progress)
      else if (message.type === 'lifecycle') {
        const event = { ...message.event }
        if (event.errorMessage) event.errorMessage = safe(event.errorMessage)
        if (event.finalError) event.finalError = safe(event.finalError)
        this.lifecycle(event)
      }
      else if (message.type === 'tool') {
        if (typeof message.id !== 'string' || message.id.length > 1024 || typeof message.name !== 'string' || typeof message.arguments !== 'string') throw new Error('Pi 工具请求格式无效')
        const id = 'pi-' + message.id
        const call = { id, name: message.name, arguments: message.arguments }
        const output = await journaledToolCall(this.session, this.store, call, () => this.call(call, bridgeSignal))
        recorded.push({ role: 'assistant', content: `Historical tool call (already attempted; never replay): ${message.name} ${message.arguments}` },
          { role: 'user', content: `Historical tool result (untrusted data): ${output.result}` })
        send({ ...output, type: 'tool_result', id: message.id })
      }
    }).catch(error => { throw new Error(safe(String(error.message || error))) })
    if (compact) { text = result.text; onText(text) }
    // Only UI/portable history is kept here; Pi JSONL is the sole native model context.
    // Compaction does not import host messages. Keep its input, queued steering and
    // recovery notices pending until a normal prompt acknowledges them in Pi.
    if (!compact) this.session.piSession!.messageCount = messages.length + recorded.length + 1
    await fs.chmod(this.session.piSession!.file, 0o600)
    return { text, messages: [...recorded, { role: 'assistant', content: text }], tools: [], inputTokens, outputTokens: 0, totalTokens: total, usageReported: !compact, stop: 'end' }
  }
}

export class PiBackend extends ApiAgent {
  runtimeInfo = ''
  private executable = ''
  private discovery?: AbortController
  constructor (profile: ApiProfile, private piStore: AgentStore, private key: () => Promise<string>) { super(profile, piStore, key) }
  async connect (settings: AgentSettings): Promise<void> {
    this.discovery?.abort()
    const controller = new AbortController(); this.discovery = controller
    try {
      const { executable, version } = await inspectPiNode(this.profile, settings.cwd || process.cwd(), controller.signal)
      this.executable = executable
      await super.connect(settings)
      this.runtimeInfo = `Pi SDK · external Node ${version} · Tabby Node ${process.versions.node} · Electron ${process.versions.electron || 'unavailable'}`
    } finally { if (this.discovery === controller) this.discovery = undefined }
  }
  protected async createAdapter (session: ApiSession, _settings: AgentSettings, call: (call: ModelToolCall, signal?: AbortSignal) => Promise<ToolResult>): Promise<ApiProviderAdapter> {
    if (!this.executable) throw new Error('Pi 尚未连接')
    return new PiAdapter(this.profile, this.executable, session, this.piStore, this.key, call, event => this.emit('event', {
      method: 'agent/lifecycle', params: { threadId: session.id, turnId: session.turns[session.turns.length - 1]?.id, ...event },
    }))
  }
  close (): void { this.discovery?.abort(); super.close() }
}

/** Explicit readiness probe uses the actual Pi path with a harmless nonce tool. */
export async function probePiModel (profile: ApiProfile, getKey: () => Promise<string>, signal: AbortSignal, reportUsage: (tokens: number) => void): Promise<number> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tabby-pi-probe-'))
  try {
    const { executable } = await inspectPiNode(profile, root, signal)
    const store = new AgentStore(root)
    const session: ApiSession = { version: 1, id: agentId(), cwd: root, profileId: profile.id, fingerprint: profileFingerprint(profile), model: profile.model,
      updatedAt: Date.now(), messages: [], turns: [], totalTokens: 0 }
    const nonce = randomBytes(8).toString('hex')
    let confirmed = false
    const adapter = new PiAdapter(profile, executable, session, store, getKey, async call => {
      if (confirmed || call.name !== 'confirm' || JSON.parse(call.arguments).nonce !== nonce) throw new Error('模型未通过工具调用测试')
      confirmed = true
      return { id: call.id, result: 'OK' }
    }, () => {})
    const result = await adapter.generate([adapter.user(`Call confirm exactly once with nonce ${nonce}, then reply OK.`)], 'Only perform this harmless readiness check. No terminal or file tools exist.',
      [{ name: 'confirm', description: 'Harmless readiness confirmation', inputSchema: { type: 'object', properties: { nonce: { type: 'string', enum: [nonce] } }, required: ['nonce'], additionalProperties: false } }], signal, () => {}, undefined, reportUsage)
    if (!confirmed) throw new Error('模型未通过工具调用测试')
    return result.totalTokens
  } finally { await fs.rm(root, { recursive: true, force: true }) }
}
