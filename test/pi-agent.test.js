const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const ts = require('typescript')
const Module = require('node:module')
const originalLoad = Module._load
Module._load = function (request, parent, main) {
  if (request === '@angular/core') return { Injectable: () => target => target }
  if (request === 'tabby-core' || request === 'tabby-terminal') return {}
  return originalLoad.call(this, request, parent, main)
}
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, experimentalDecorators: true },
}).outputText, filename)
const { PiBackend, PiAdapter, runPiProcess, inspectPiRuntime } = require('../src/pi-agent.ts')
const { AgentStore, agentId, profileFingerprint } = require('../src/agent-store.ts')
const { compactionBoundary, contextHash, projectApiContext } = require('../src/api-context.ts')
const { ApiAgent } = require('../src/api-agent.ts')
Module._load = originalLoad
const [major, minor] = process.versions.node.split('.').map(Number)
function integration (name, options, run) {
  if (typeof options === 'function') { run = options; options = {} }
  const skip = major > 22 || major === 22 && minor >= 19 ? false : `Pi requires Node >=22.19.0; current Node is ${process.versions.node}`
  return test(name, { ...options, skip }, run)
}
const settings = { sandbox: 'workspace-write', approvalPolicy: 'never', goalTokenBudget: 0, cwd: process.cwd() }
const finished = agent => new Promise(resolve => {
  const handler = event => { if (event.method === 'turn/completed') { agent.off('event', handler); resolve(event.params.turn) } }
  agent.on('event', handler)
})

integration('Pi defaults to the host runtime even with no node on PATH', { timeout: 15000 }, async t => {
  const env = { ...process.env }
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in env)) delete process.env[name]; Object.assign(process.env, env) })
  for (const name of Object.keys(process.env)) if (name.toUpperCase() === 'PATH') process.env[name] = ''
  const f = await fixture(t, (_req, res) => reply(res, 'HOST_NODE_OK'), { piNodeExecutable: '' })
  assert.match(f.agent.runtimeInfo, /Tabby built-in Node/)
  const id = await f.agent.openThread(process.cwd(), settings)
  const done = finished(f.agent)
  await f.agent.startTurn(id, 'Reply HOST_NODE_OK', process.cwd(), settings)
  assert.equal((await done).status, 'completed')
  assert.equal(f.requests.length, 1)
})

test('Pi selects the Electron main bridge before any external executable lookup', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron')
  Object.defineProperty(process.versions, 'electron', { value: 'fixture', configurable: true })
  const load = Module._load
  let owner
  const bridge = { inspect: () => ({ node: '24.21.0' }), fork: id => { owner = id; return {} } }
  Module._load = function (request, parent, main) {
    if (request === '@electron/remote') return { getGlobal: () => ({ getBuiltinModule: () => ({ createRequire: () => () => bridge }) }), getCurrentWebContents: () => ({ id: 7 }) }
    return load.call(this, request, parent, main)
  }
  try {
    const runtime = await inspectPiRuntime({ piNodeExecutable: '' }, process.cwd(), new AbortController().signal)
    assert.equal(runtime.source, 'host')
    assert.equal(runtime.version, '24.21.0')
    runtime.launch()
    assert.equal(owner, 7)
  } finally { Module._load = load; if (descriptor) Object.defineProperty(process.versions, 'electron', descriptor); else delete process.versions.electron }
})

integration('packaged Pi sidecar works outside the repository without installed SDK packages', { timeout: 15000 }, async t => {
  const f = await fixture(t, (_req, res, _body, count) => count === 1
    ? reply(res, '', [{ name: 'fixture_probe', arguments: '{}' }])
    : reply(res, 'STANDALONE_OK'))
  const directory = path.join(f.root, 'isolated-runtime')
  fs.mkdirSync(directory)
  const sidecar = path.join(directory, 'sidecar.mjs')
  fs.copyFileSync(path.resolve(__dirname, '../dist/pi/sidecar.mjs'), sidecar)
  let calls = 0
  const result = await runPiProcess(process.execPath, {
    directory: path.join(f.root, 'sessions'), profile: f.profile, key: '', system: 'Use only the supplied host tool.',
    tools: [{ name: 'fixture_probe', description: 'Return local fixture evidence.', inputSchema: { type: 'object', properties: {} } }],
    sourceOffset: 0, sourceMessages: [[{ role: 'user', content: 'Use fixture_probe, then reply STANDALONE_OK.' }]], activeGoal: false,
  }, new AbortController().signal, async (message, send) => {
    if (message.type === 'ready') send({ type: 'start' })
    if (message.type === 'accepted') send({ type: 'accepted' })
    if (message.type === 'tool') {
      assert.equal(message.name, 'fixture_probe')
      calls++
      send({ type: 'tool_result', id: message.id, result: '{"verified":true}', error: false })
    }
  }, sidecar)
  assert.equal(result.text, 'STANDALONE_OK')
  assert.equal(calls, 1)
  assert.equal(f.requests.length, 2)
  assert.deepEqual(f.requests[0].body.tools.map(tool => tool.function.name), ['fixture_probe'])
})
async function fixture (t, handler, overrides = {}, Backend = PiBackend) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-pi 中文 space-'))
  const store = new AgentStore(root)
  const requests = []
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    const data = JSON.parse(body)
    requests.push({ url: req.url, headers: req.headers, body: data })
    handler(req, res, data, requests.length)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const profile = { id: 'pi-fixture', name: 'Pi fixture', runtime: 'pi', provider: 'custom', apiFormat: 'chat-completions', keySource: 'none',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture', thinking: 'disabled', reasoningEffort: '',
    contextWindow: 8000, maxOutputTokens: 512, maxIterations: 0, piNodeExecutable: process.execPath, threads: {}, ...overrides }
  const agent = new Backend(profile, store, async () => profile.keySource === 'none' ? '' : 'fixture-key')
  t.after(async () => { agent.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }) })
  await agent.connect(settings)
  return { root, store, profile, agent, requests }
}
function reply (res, content, calls, finishReason) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write('data: ' + JSON.stringify({ id: 'chat-fixture', object: 'chat.completion.chunk', choices: [{ index: 0,
    delta: { role: 'assistant', ...(content ? { content } : {}), ...(calls ? { tool_calls: calls.map((call, index) => ({ index, id: call.id || `action-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args || {}) } })) } : {}) }, finish_reason: null }] }) + '\n\n')
  res.write('data: ' + JSON.stringify({ id: 'chat-fixture', choices: [{ index: 0, delta: {}, finish_reason: finishReason || (calls ? 'tool_calls' : 'stop') }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }) + '\n\n')
  res.end('data: [DONE]\n\n')
}

integration('Pi real HTTP: host tools only, sequential policy, native persistence and restart', { timeout: 30000 }, async t => {
  const f = await fixture(t, (_req, res, data, n) => {
    assert.ok(data.tools.length > 0)
    assert.ok(!data.tools.some(tool => ['bash', 'read', 'write', 'edit'].includes(tool.function.name)))
    if (n === 1) reply(res, '', [{ name: 'list_tabs' }, { name: 'read_tab', args: { tabId: 'tab1' } }])
    else reply(res, 'Verified terminal output.')
  })
  let active = 0, peak = 0, calls = 0, contextTokens = 0
  f.agent.on('event', event => {
    if (event.method === 'thread/tokenUsage/updated' && event.params.tokenUsage.last) contextTokens = event.params.tokenUsage.last.totalTokens
    if (event.method !== 'item/tool/call') return
    peak = Math.max(peak, ++active); calls++
    setTimeout(() => { active--; f.agent.respond(event.id, { success: true, contentItems: [{ text: 'fixture observed' }] }) }, 10)
  })
  const id = await f.agent.openThread(process.cwd(), settings)
  let done = finished(f.agent)
  await f.agent.startTurn(id, 'Inspect terminals', process.cwd(), settings)
  { const result = await done; assert.equal(result.status, 'completed', JSON.stringify(result)) }
  assert.equal(calls, 2); assert.equal(peak, 1)
  assert.equal(f.requests.length, 2)
  assert.equal(contextTokens, 20, 'context usage must report the actual last model input rather than zero')
  assert.equal(f.requests[0].headers.authorization, undefined)
  const saved = await f.store.load(id)
  assert.ok(saved.piSession.file.endsWith('.jsonl'))
  assert.ok(fs.existsSync(saved.piSession.file))
  const before = fs.readFileSync(saved.piSession.file, 'utf8')
  assert.match(before, /toolResult/)
  const restarted = new PiBackend(f.profile, f.store, async () => '')
  t.after(() => restarted.close())
  await restarted.connect(settings)
  await restarted.resumeThread(id, process.cwd(), settings)
  const usage = (await restarted.request('thread/read', { threadId: id })).thread.tokenUsage
  assert.ok(usage.total.totalTokens >= 60)
  assert.equal(usage.last.totalTokens, 20)
  done = finished(restarted)
  await restarted.startTurn(id, 'Summarize what was observed', process.cwd(), settings)
  { const result = await done; assert.equal(result.status, 'completed', JSON.stringify(result)) }
  assert.equal(f.requests.length, 3)
  assert.ok(f.requests[2].body.messages.some(m => m.role === 'tool'))
  assert.ok(fs.readFileSync(saved.piSession.file, 'utf8').startsWith(before))
})

integration('Pi real HTTP: 429 after a tool retries inference without replay and waits for settled', { timeout: 30000 }, async t => {
  const f = await fixture(t, (_req, res, _data, n) => {
    if (n === 1) reply(res, '', [{ name: 'send_input', args: { tabId: 'tab1', text: 'echo observed', submit: true } }])
    else if (n === 2) { res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: '429 Too Many Requests', type: 'rate_limit_error' } })) }
    else reply(res, 'Observed success.')
  })
  let calls = 0
  const lifecycle = []
  f.agent.on('event', event => {
    if (event.method === 'agent/lifecycle') lifecycle.push(event.params)
    if (event.method === 'item/tool/call') { calls++; f.agent.respond(event.id, { success: true, contentItems: [{ text: 'command sent; observed result separately' }] }) }
  })
  const id = await f.agent.openThread(process.cwd(), settings)
  const done = finished(f.agent)
  await f.agent.startTurn(id, 'Run fixture', process.cwd(), settings)
  const turn = await done
  assert.equal(turn.status, 'completed', JSON.stringify(turn))
  assert.equal(calls, 1); assert.equal(f.requests.length, 3)
  assert.ok(lifecycle.find(e => e.type === 'auto_retry_start' && e.delayMs > 0 && e.attempt === 1))
  assert.ok(lifecycle.find(e => e.type === 'agent_settled'))
})

integration('Pi real HTTP: cancelling retry backoff makes no later request', { timeout: 15000 }, async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: '429 Too Many Requests' } })) })
  const id = await f.agent.openThread(process.cwd(), settings)
  const done = finished(f.agent)
  const retry = new Promise(resolve => f.agent.on('event', event => { if (event.params.type === 'auto_retry_start') resolve() }))
  const turn = await f.agent.startTurn(id, 'cancel backoff', process.cwd(), settings)
  await retry
  await f.agent.interrupt(id, turn)
  assert.equal((await done).status, 'interrupted')
  assert.equal(f.requests.length, 1)
})

test('context projection cuts complete tool batches, keeps raw data and rejects stale summary provenance', () => {
  const history = [{ role: 'user', content: 'constraints' }, { role: 'assistant', tool_calls: [{ id: 'a' }, { id: 'b' }] },
    { role: 'tool', tool_call_id: 'a', content: 'one' }, { role: 'tool', tool_call_id: 'b', content: 'two' },
    { role: 'user', content: 'next' }, { role: 'assistant', content: 'observed' }, { role: 'user', content: 'latest' }]
  const raw = JSON.stringify(history)
  const firstKeptIndex = compactionBoundary(history)
  assert.equal(firstKeptIndex, 4)
  const session = { messages: history, compactions: [{ firstKeptIndex, sourceHash: contextHash(history.slice(0, firstKeptIndex)), summary: 'all constraints; both actions observed' }] }
  assert.equal(projectApiContext(session).length, 4)
  assert.equal(JSON.stringify(history), raw)
  history[0].content = 'changed'
  assert.throws(() => projectApiContext(session), /来源/)
  const claude = [{ role: 'user', content: 'old' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'one' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'one', content: 'observed' }] }, { role: 'user', content: 'new' }]
  assert.equal(compactionBoundary(claude, 1), 3)
})

integration('Pi real HTTP: quota exhaustion is terminal and token budget prevents terminal tools', { timeout: 20000 }, async t => {
  const quota = await fixture(t, (_req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'insufficient_quota: You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' } }))
  })
  let id = await quota.agent.openThread(process.cwd(), settings)
  let done = finished(quota.agent)
  await quota.agent.startTurn(id, 'quota fixture', process.cwd(), settings)
  assert.equal((await done).status, 'failed')
  assert.equal(quota.requests.length, 1)
  const budget = await fixture(t, (_req, res) => reply(res, '', [{ name: 'send_input', args: { tabId: 'one', text: 'MUST NOT EXECUTE', submit: true } }]))
  let calls = 0
  budget.agent.on('event', event => { if (event.method === 'item/tool/call') calls++ })
  id = await budget.agent.openThread(process.cwd(), settings)
  await budget.agent.setGoal(id, 'Budget fixture', 25)
  done = finished(budget.agent)
  await budget.agent.startTurn(id, 'budget fixture', process.cwd(), settings)
  assert.equal((await done).status, 'failed')
  assert.equal(calls, 0)
  assert.equal(budget.requests.length, 1)
  const saved = await budget.store.load(id)
  assert.equal(saved.goal.status, 'budgetLimited')
  assert.ok(saved.goal.usedTokens >= 25)
})

integration('Pi real HTTP: the native goal loop finishes once without an outer API replay', { timeout: 20000 }, async t => {
  const f = await fixture(t, (_req, res, _data, n) => {
    if (n === 1) reply(res, 'Checking the observed result.')
    else if (n === 2) reply(res, '', [{ name: 'agent_goal_update', args: { status: 'complete', evidence: 'Fixture requirements verified' } }])
    else reply(res, 'Task verified complete.')
  })
  const id = await f.agent.openThread(process.cwd(), settings)
  await f.agent.setGoal(id, 'Verify fixture', 0)
  const done = finished(f.agent)
  await f.agent.startTurn(id, 'finish fixture', process.cwd(), settings)
  assert.equal((await done).status, 'completed')
  assert.equal(f.requests.length, 3)
  assert.equal((await f.agent.getGoal(id)).status, 'complete')
})

// Ten turns launch separate sidecars; Windows Node 22.19 takes ~34s even without model latency.
// Leave CI headroom on every platform while retaining all compaction/accounting assertions.
integration('Pi real HTTP: repeated compaction retains raw entries, accounts summary costs and resumes', { timeout: 90000 }, async t => {
  const f = await fixture(t, (_req, res) => reply(res, '# Goal\nPreserve user constraints.\n# Pending\nStep 2 needs a fresh checkpoint.\n' + 'Observed result, never replay. '.repeat(120)))
  const id = await f.agent.openThread(process.cwd(), settings)
  async function turn (text) {
    const done = finished(f.agent)
    await f.agent.startTurn(id, text, process.cwd(), settings)
    const result = await done
    assert.equal(result.status, 'completed', JSON.stringify(result))
  }
  for (let i = 0; i < 4; i++) await turn('Constraint and pending checkpoint ' + i + ': ' + 'terminal evidence '.repeat(180))
  const saved = await f.store.load(id)
  const entriesBefore = fs.readFileSync(saved.piSession.file, 'utf8').trim().split('\n').map(JSON.parse)
  const callsBefore = f.requests.length
  await turn('/compact')
  const afterFirst = fs.readFileSync(saved.piSession.file, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(afterFirst.filter(e => e.type === 'compaction').length, 1)
  assert.ok(entriesBefore.every(before => afterFirst.some(after => before.id === after.id)))
  assert.ok(f.requests.length > callsBefore)
  for (let i = 0; i < 3; i++) await turn('More observed results ' + 'fresh evidence '.repeat(180))
  await turn('/compact')
  const afterSecond = fs.readFileSync(saved.piSession.file, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(afterSecond.filter(e => e.type === 'compaction').length, 2)
  assert.ok(afterSecond.filter(e => e.type === 'compaction').every(e => e.firstKeptEntryId))
  assert.ok((await f.store.load(id)).totalTokens >= f.requests.length * 30)
  await turn('Resume from the summary; never replay commands')
  assert.ok(f.requests.at(-1).body.messages.some(m => JSON.stringify(m).includes('compacted')))
})

integration('Pi real HTTP: policy denial remains in durable history and no host mutation executes', { timeout: 15000 }, async t => {
  const f = await fixture(t, (_req, res, _data, n) => n === 1 ? reply(res, '', [{ name: 'send_input', args: { tabId: 'one', text: 'forbidden' } }]) : reply(res, 'Read-only policy respected.'))
  const id = await f.agent.openThread(process.cwd(), settings)
  let calls = 0
  f.agent.on('event', event => { if (event.method === 'item/tool/call') calls++ })
  const done = finished(f.agent)
  await f.agent.startTurn(id, 'read-only fixture', process.cwd(), { ...settings, sandbox: 'read-only' })
  assert.equal((await done).status, 'completed')
  assert.equal(calls, 0)
  const saved = await f.store.load(id)
  assert.match(fs.readFileSync(saved.piSession.file, 'utf8'), /isError.*true/)
})

test('API manual compaction preserves tool batches and raw history across reload', async t => {
  const f = await fixture(t, (_req, res) => reply(res, 'Preserved constraints, pending step 2, both tool results.'), { runtime: undefined }, ApiAgent)
  const api = f.agent
  const id = await api.openThread(process.cwd(), settings)
  const saved = await f.store.load(id)
  saved.messages = [{ role: 'user', content: 'constraint' }, { role: 'assistant', tool_calls: [{ id: 'a', type: 'function', function: { name: 'list_tabs', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'a', content: 'observed' }, { role: 'user', content: 'pending step 2' }, { role: 'assistant', content: 'still pending' }, { role: 'user', content: 'current task' }]
  await f.store.save(saved)
  await api.resumeThread(id, process.cwd(), settings)
  const original = JSON.stringify(saved.messages)
  const done = finished(api)
  await api.startTurn(id, '/compact', process.cwd(), settings)
  assert.equal((await done).status, 'completed')
  const compacted = await f.store.load(id)
  assert.equal(JSON.stringify(compacted.messages.slice(0, saved.messages.length)), original)
  assert.equal(compacted.compactions.length, 1)
  assert.ok(compacted.totalTokens > 0)
  assert.ok(projectApiContext(compacted).length < compacted.messages.length)
})

for (const protocol of ['responses', 'anthropic']) integration(`Pi actual ${protocol} HTTP protocol streams through the external runtime`, { timeout: 15000 }, async t => {
  const f = await fixture(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = event => res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n')
    if (protocol === 'responses') {
      assert.equal(req.url, '/v1/responses')
      assert.equal(req.headers.authorization, 'Bearer fixture-key')
      const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Fixture response', annotations: [] }] }
      emit({ type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress', output: [] } })
      emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } })
      emit({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
      emit({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'Fixture response' })
      emit({ type: 'response.output_item.done', output_index: 0, item })
      emit({ type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [item], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } })
    } else {
      assert.equal(new URL(req.url, 'http://localhost').pathname, '/v1/messages')
      assert.equal(req.headers['x-api-key'], 'fixture-key')
      emit({ type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture', content: [], usage: { input_tokens: 20, output_tokens: 0 } } })
      emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Fixture response' } })
      emit({ type: 'content_block_stop', index: 0 })
      emit({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } })
      emit({ type: 'message_stop' })
    }
    res.end()
  }, protocol === 'responses' ? { provider: 'openai', keySource: 'direct' } : { provider: 'claude', keySource: 'direct' })
  const id = await f.agent.openThread(process.cwd(), settings)
  const done = finished(f.agent)
  await f.agent.startTurn(id, 'protocol fixture', process.cwd(), settings)
  const result = await done
  assert.equal(result.status, 'completed', JSON.stringify(result))
  const saved = await f.store.load(id)
  assert.match(saved.turns.at(-1).items.find(item => item.type === 'agentMessage').text, /Fixture response/)
  assert.ok(saved.totalTokens >= 30)
  assert.equal(f.requests.length, 1)
})

test('journaled tool bridge reuses known results after reload and never replays an unknown action', async t => {
  const { journaledToolCall } = require('../src/host-tool-bridge.ts')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-pi-journal-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = new AgentStore(root)
  const session = { version: 1, id: agentId(), cwd: root, profileId: 'fixture', fingerprint: 'fixture', model: 'fixture', updatedAt: Date.now(), messages: [], turns: [], totalTokens: 0 }
  const call = { id: 'pi-stable-action', name: 'send_input', arguments: '{"text":"modify once"}' }
  let count = 0
  const execute = async () => { count++; return { id: call.id, result: 'observed' } }
  assert.equal((await journaledToolCall(session, store, call, execute)).result, 'observed')
  const restored = await store.load(session.id)
  assert.equal((await journaledToolCall(restored, store, call, execute)).result, 'observed')
  assert.equal(count, 1)
  await assert.rejects(journaledToolCall(restored, store, { ...call, arguments: '{}' }, execute), /冲突/)
  const lost = { ...call, id: 'pi-lost-response' }
  await assert.rejects(journaledToolCall(restored, store, lost, async () => { count++; throw new Error('response lost after send') }), /response lost/)
  const interrupted = await store.load(session.id)
  const result = await journaledToolCall(interrupted, store, lost, execute)
  assert.equal(result.error, true)
  assert.match(result.result, /结果未知/)
  assert.equal(count, 2)
})

integration('private process bridge cancels a waiting host tool when the sidecar dies', { timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-pi-crash-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const entry = path.join(root, 'crash.mjs')
  fs.writeFileSync(entry, `process.stdin.once('data', () => { process.stdout.write(JSON.stringify({type:'tool'})+'\\n'); setTimeout(() => process.exit(1), 50) })`)
  let cancelled = false
  await assert.rejects(runPiProcess(process.execPath, {}, new AbortController().signal, async (_message, _send, signal) => {
    await new Promise(resolve => signal.addEventListener('abort', () => { cancelled = true; resolve() }, { once: true }))
  }, entry), /未正常结束/)
  assert.equal(cancelled, true)
})

integration('Pi accepted-input recovery reconciles a native cursor after host persistence failure', { timeout: 20000 }, async t => {
  const f = await fixture(t, (_req, res) => reply(res, 'Recovered without replay.'))
  const id = await f.agent.openThread(process.cwd(), settings)
  const save = f.store.save.bind(f.store)
  let failing = true
  f.store.save = session => failing && session.piSession?.messageCount > 0 ? Promise.reject(new Error('host disk fixture failure')) : save(session)
  let done = finished(f.agent)
  await f.agent.startTurn(id, 'ORIGINAL_INPUT_ONCE', process.cwd(), settings)
  assert.equal((await done).status, 'failed')
  assert.equal(f.requests.length, 0, 'host acceptance must be saved before inference')
  const index = await f.store.load(id)
  assert.equal(index.piSession.messageCount, 0)
  assert.match(fs.readFileSync(index.piSession.file, 'utf8'), /tabby-input/)
  failing = false
  const resumed = new PiBackend(f.profile, f.store, async () => '')
  t.after(() => resumed.close())
  await resumed.connect(settings)
  await resumed.resumeThread(id, process.cwd(), settings)
  done = finished(resumed)
  await resumed.startTurn(id, 'Inspect state and resume', process.cwd(), settings)
  const result = await done
  assert.equal(result.status, 'completed', JSON.stringify(result))
  assert.equal(f.requests.length, 1)
  const native = fs.readFileSync(index.piSession.file, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(native.filter(entry => entry.type === 'message' && entry.message.role === 'user' && JSON.stringify(entry.message).includes('ORIGINAL_INPUT_ONCE')).length, 1)
})

integration('Pi model switch creates a portable handoff and preserves the original native history', { timeout: 15000 }, async t => {
  const f = await fixture(t, (_req, res) => reply(res, 'Observed fixture state.'))
  const first = await f.agent.openThread(process.cwd(), settings)
  let done = finished(f.agent)
  await f.agent.startTurn(first, 'original constraints', process.cwd(), settings)
  assert.equal((await done).status, 'completed')
  const original = await f.store.load(first)
  const raw = fs.readFileSync(original.piSession.file, 'utf8')
  const switched = new PiBackend({ ...f.profile, model: 'fixture-new' }, f.store, async () => '')
  t.after(() => switched.close())
  await switched.connect(settings)
  const next = await switched.openThread(process.cwd(), settings, first)
  assert.notEqual(next, first)
  done = finished(switched)
  await switched.startTurn(next, 'continue with the new model', process.cwd(), settings)
  assert.equal((await done).status, 'completed')
  assert.equal(fs.readFileSync(original.piSession.file, 'utf8'), raw)
  assert.equal(f.requests.at(-1).body.model, 'fixture-new')
  assert.ok(JSON.stringify(f.requests.at(-1).body.messages).includes('original constraints'))
})

integration('Pi summary budget exhaustion preserves history and stops before a second summary request', { timeout: 20000 }, async t => {
  const f = await fixture(t, (_req, res) => reply(res, 'Goal and pending checkpoint retained. ' + 'observed evidence '.repeat(160)))
  const id = await f.agent.openThread(process.cwd(), settings)
  for (let i = 0; i < 4; i++) {
    const done = finished(f.agent)
    await f.agent.startTurn(id, 'constraint ' + 'terminal result '.repeat(180), process.cwd(), settings)
    assert.equal((await done).status, 'completed')
  }
  const before = await f.store.load(id)
  const raw = fs.readFileSync(before.piSession.file, 'utf8')
  await f.agent.setGoal(id, 'Summary budget fixture', 25)
  const calls = f.requests.length
  const done = finished(f.agent)
  await f.agent.startTurn(id, '/compact', process.cwd(), settings)
  assert.equal((await done).status, 'failed')
  assert.equal(f.requests.length - calls, 1)
  const saved = await f.store.load(id)
  assert.equal(saved.goal.status, 'budgetLimited')
  assert.ok(saved.goal.usedTokens >= 25)
  assert.ok(fs.readFileSync(saved.piSession.file, 'utf8').startsWith(raw))
})

integration('empty Pi /compact makes no inference request and leaves the next real prompt intact', { timeout: 15000 }, async t => {
  const f = await fixture(t, (_req, res) => reply(res, 'Ready for the actual task.'))
  const id = await f.agent.openThread(process.cwd(), settings)
  let done = finished(f.agent)
  await f.agent.startTurn(id, '/compact', process.cwd(), settings)
  assert.equal((await done).status, 'completed')
  assert.equal(f.requests.length, 0)
  done = finished(f.agent)
  await f.agent.startTurn(id, 'ACTUAL_TASK', process.cwd(), settings)
  assert.equal((await done).status, 'completed')
  assert.ok(JSON.stringify(f.requests[0].body.messages).includes('ACTUAL_TASK'))
})

test('API automatic compaction spends its summary budget before any subsequent inference or tool', async t => {
  const f = await fixture(t, (_req, res) => reply(res, 'Earlier constraints and pending checkpoint retained.'), { runtime: undefined, autoCompact: true, contextWindow: 100 }, ApiAgent)
  const api = f.agent
  const id = await api.openThread(process.cwd(), settings)
  const saved = await f.store.load(id)
  saved.messages = [{ role: 'user', content: 'original constraints '.repeat(100) }, { role: 'assistant', content: 'observed' },
    { role: 'user', content: 'pending' }, { role: 'assistant', content: 'pending checkpoint' }, { role: 'user', content: 'keep last turns' }]
  await f.store.save(saved)
  await api.resumeThread(id, process.cwd(), settings)
  await api.setGoal(id, 'Budget fixture', 25)
  const done = finished(api)
  await api.startTurn(id, 'continue', process.cwd(), settings)
  assert.equal((await done).status, 'failed')
  assert.equal(f.requests.length, 1)
  const result = await f.store.load(id)
  assert.equal(result.goal.status, 'budgetLimited')
  assert.equal(result.compactions.length, 1)
})

integration('Pi readiness probe uses the external runtime and a harmless nonce tool', { timeout: 15000 }, async t => {
  const { probePiModel } = require('../src/pi-agent.ts')
  const f = await fixture(t, (_req, res, data, n) => {
    assert.deepEqual(data.tools.map(tool => tool.function.name), ['confirm'])
    if (n === 1) {
      const nonce = /nonce ([a-f0-9]{16})/.exec(JSON.stringify(data.messages))?.[1]
      assert.ok(nonce)
      reply(res, '', [{ name: 'confirm', args: { nonce } }])
    } else reply(res, 'OK')
  })
  let usage = 0
  const tokens = await probePiModel(f.profile, async () => '', new AbortController().signal, count => { usage = count })
  assert.equal(f.requests.length, 2)
  assert.ok(tokens >= 60)
  assert.equal(tokens, usage)
})

integration('missing authoritative Pi history fails closed instead of silently starting a fresh context', { timeout: 15000 }, async t => {
  const f = await fixture(t, (_req, res) => reply(res, 'Original observation retained.'))
  const id = await f.agent.openThread(process.cwd(), settings)
  let done = finished(f.agent)
  await f.agent.startTurn(id, 'original', process.cwd(), settings)
  assert.equal((await done).status, 'completed')
  const saved = await f.store.load(id)
  fs.unlinkSync(saved.piSession.file)
  done = finished(f.agent)
  await f.agent.startTurn(id, 'resume without replaying anything', process.cwd(), settings)
  const result = await done
  assert.equal(result.status, 'failed')
  assert.match(result.error.message, /missing or unreadable/)
  assert.equal(f.requests.length, 1)
})

integration('native Goal continuation treats fresh tool observations as progress despite identical text', { timeout: 20000 }, async t => {
  const f = await fixture(t, (_req, res, _data, n) => {
    if (n <= 6) {
      if (n % 2) reply(res, '', [{ id: 'fresh-observation-' + n, name: 'list_tabs' }])
      else reply(res, 'Progress observed.')
    } else if (n === 7) reply(res, '', [{ id: 'complete-after-observations', name: 'agent_goal_update', args: { status: 'complete', evidence: 'Three distinct fresh observations verified' } }])
    else reply(res, 'Verified complete.')
  })
  let observed = 0
  f.agent.on('event', event => { if (event.method === 'item/tool/call') f.agent.respond(event.id, { success: true, contentItems: [{ text: 'fresh observed result ' + ++observed }] }) })
  const id = await f.agent.openThread(process.cwd(), settings)
  await f.agent.setGoal(id, 'Observe changing state', 0)
  const done = finished(f.agent)
  await f.agent.startTurn(id, 'observe until verified', process.cwd(), settings)
  const result = await done
  assert.equal(result.status, 'completed', JSON.stringify(result))
  assert.equal(observed, 3)
  assert.equal(f.requests.length, 8)
})

for (const compactable of [false, true]) integration(`review regression: interrupted steering survives ${compactable ? 'real' : 'no-op'} compaction and restart`, { timeout: 30000 }, async t => {
  const warmTurns = compactable ? 4 : 1
  let reached
  const pendingRequest = new Promise(resolve => { reached = resolve })
  const f = await fixture(t, (_req, res, _data, n) => {
    if (n === warmTurns + 1) { reached(); return }
    reply(res, compactable ? 'Preserve constraints and observed evidence. '.repeat(180) : 'Observed.')
  })
  const id = await f.agent.openThread(process.cwd(), settings)
  async function turn (agent, text) {
    const done = finished(agent)
    await agent.startTurn(id, text, process.cwd(), settings)
    const result = await done
    assert.equal(result.status, 'completed', JSON.stringify(result))
  }
  for (let i = 0; i < warmTurns; i++) await turn(f.agent, compactable ? 'Earlier constraints ' + 'observed terminal data '.repeat(180) : 'initial request')
  const interrupted = finished(f.agent)
  const running = await f.agent.startTurn(id, 'Wait for a result', process.cwd(), settings)
  await pendingRequest
  await f.agent.steer(id, running, 'QUEUED_CORRECTION: preserve this user constraint')
  await f.agent.interrupt(id, running)
  assert.equal((await interrupted).status, 'interrupted')
  const before = await f.store.load(id)
  assert.ok(JSON.stringify(before.messages.slice(before.piSession.messageCount)).includes('QUEUED_CORRECTION'))
  const callsBefore = f.requests.length
  await turn(f.agent, '/compact')
  const after = await f.store.load(id)
  assert.equal(after.piSession.messageCount, before.piSession.messageCount, 'compaction must not acknowledge unimported host input')
  const entries = fs.readFileSync(after.piSession.file, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(entries.filter(e => e.type === 'compaction').length, compactable ? 1 : 0)
  assert.equal(f.requests.length > callsBefore, compactable)
  const resumed = new PiBackend(f.profile, f.store, async () => '')
  t.after(() => resumed.close())
  await resumed.connect(settings)
  await resumed.resumeThread(id, process.cwd(), settings)
  await turn(resumed, 'Continue from actual state')
  const handoff = JSON.stringify(f.requests.at(-1).body.messages.filter(m => m.role === 'user').at(-1).content)
  assert.ok(handoff.includes('QUEUED_CORRECTION'), 'the queued correction must reach Pi on continuation')
  assert.ok(handoff.includes('上一回合中断或失败'), 'the unknown-outcome recovery notice must also reach Pi')
  const native = fs.readFileSync(after.piSession.file, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(native.filter(e => e.type === 'message' && e.message.role === 'user' && JSON.stringify(e.message).includes('QUEUED_CORRECTION')).length, 1)
})

for (const activeGoal of [false, true]) integration(`review regression: length-limited reply remains incomplete ${activeGoal ? 'with' : 'without'} a Goal`, { timeout: 15000 }, async t => {
  const f = await fixture(t, (_req, res) => reply(res, 'PARTIAL_REPLY', undefined, 'length'))
  const id = await f.agent.openThread(process.cwd(), settings)
  if (activeGoal) await f.agent.setGoal(id, 'Finish the requested answer', 0)
  const done = finished(f.agent)
  await f.agent.startTurn(id, 'Answer the request', process.cwd(), settings)
  const result = await done
  assert.equal(result.status, 'failed', JSON.stringify(result))
  assert.match(result.error.message, /output.*limit|incomplete/i)
  assert.equal(f.requests.length, 1, 'truncation must not silently replay the prompt or continue the Goal')
  const saved = await f.store.load(id)
  assert.ok(saved.turns.at(-1).items.some(item => item.type === 'agentMessage' && item.text.includes('PARTIAL_REPLY')))
  assert.equal(saved.totalTokens, 30)
  if (activeGoal) assert.equal(saved.goal.status, 'active')
})

for (const baseUrl of ['https://api.kimi.com/coding/v1', 'https://api.kimi.ai/coding/v1', 'https://proxy.example/kimi/v1']) integration(`review regression: Kimi Coding wire compatibility at ${baseUrl}`, { timeout: 15000 }, async t => {
  const { pathToFileURL } = require('node:url')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-kimi-wire-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const entry = path.join(root, 'capture.mjs')
  // Intercept the real SDK fetch boundary, keeping production URLs for URL inference.
  // No DNS, credentials or real model traffic is involved.
  fs.writeFileSync(entry, `globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const body = JSON.parse(await request.text())
    process.stdout.write(JSON.stringify({type:'wire',url:request.url,body})+'\\n')
    const events = [{id:'fixture',choices:[{index:0,delta:{role:'assistant',content:'OK'},finish_reason:null}]},
      {id:'fixture',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}}]
    return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\\n\\n').join('')+'data: [DONE]\\n\\n',{headers:{'content-type':'text/event-stream'}})
  }
  await import(${JSON.stringify(pathToFileURL(path.resolve(__dirname, '../dist/pi/sidecar.mjs')).href)})`)
  let wire
  const result = await runPiProcess(process.execPath, { directory: path.join(root, 'sessions'), key: 'fixture-key',
    profile: { provider: 'kimi-coding', baseUrl, model: 'kimi-for-coding', thinking: 'enabled', reasoningEffort: 'high', contextWindow: 8000, maxOutputTokens: 512 },
    system: 'Use the supplied system instructions.', tools: [], sourceOffset: 0, sourceMessages: [[{ role: 'user', content: 'Reply OK' }]], activeGoal: false,
  }, new AbortController().signal, async (message, send) => {
    if (message.type === 'ready') send({ type: 'start' })
    if (message.type === 'accepted') send({ type: 'accepted' })
    if (message.type === 'wire') wire = message
  }, entry)
  assert.equal(result.text, 'OK')
  assert.equal(wire.url, baseUrl + '/chat/completions')
  assert.ok(wire.body.messages.some(m => m.role === 'system'))
  assert.ok(wire.body.messages.every(m => m.role !== 'developer'))
  assert.equal(wire.body.max_tokens, 512)
  assert.equal(wire.body.max_completion_tokens, undefined)
  assert.equal(wire.body.reasoning_effort, 'high')
  assert.deepEqual(wire.body.thinking, { type: 'enabled' })
})

for (const variant of ['google-native', 'openrouter-native', 'openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']) {
  integration(`Pi P0/P1 ${variant}: packaged stream, explicit key, host-only tool round trip`, { timeout: 20000 }, async t => {
    const protocol = variant === 'google-native' ? 'google-generative-ai' : variant === 'openrouter-native' ? 'openai-completions' : variant
    const native = variant.endsWith('-native')
    const config = native ? { version: 1, mode: 'native', providerId: variant === 'google-native' ? 'google' : 'openrouter' }
      : { version: 1, mode: 'custom', api: protocol, maxTokens: 1024 }
    const f = await fixture(t, (req, res, body, n) => {
      assert.ok(n <= 2, 'one tool round only')
      if (protocol === 'openai-completions') {
        assert.equal(req.url, '/v1/chat/completions')
        assert.deepEqual(body.tools.map(tool => tool.function.name), ['fixture_probe'])
        reply(res, n === 1 ? '' : 'VERIFIED', n === 1 ? [{ name: 'fixture_probe' }] : undefined)
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const emit = event => res.write(`${event.type ? 'event: ' + event.type + '\n' : ''}data: ${JSON.stringify(event)}\n\n`)
      if (protocol === 'google-generative-ai') {
        assert.match(req.url, /:streamGenerateContent/)
        assert.equal(req.headers['x-goog-api-key'], 'fixture-key')
        assert.deepEqual(body.tools.flatMap(tool => tool.functionDeclarations || []).map(tool => tool.name), ['fixture_probe'])
        emit({ candidates: [{ index: 0, content: { role: 'model', parts: n === 1 ? [{ functionCall: { name: 'fixture_probe', args: {} } }] : [{ text: 'VERIFIED' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 30 } })
      } else if (protocol === 'anthropic-messages') {
        assert.equal(req.headers['x-api-key'], 'fixture-key')
        assert.equal(new URL(req.url, 'http://localhost').pathname, '/v1/messages')
        assert.deepEqual(body.tools.map(tool => tool.name), ['fixture_probe'])
        emit({ type: 'message_start', message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'fixture', content: [], usage: { input_tokens: 20, output_tokens: 0 } } })
        emit({ type: 'content_block_start', index: 0, content_block: n === 1 ? { type: 'tool_use', id: 'call_probe', name: 'fixture_probe', input: {} } : { type: 'text', text: '' } })
        emit({ type: 'content_block_delta', index: 0, delta: n === 1 ? { type: 'input_json_delta', partial_json: '{}' } : { type: 'text_delta', text: 'VERIFIED' } })
        emit({ type: 'content_block_stop', index: 0 })
        emit({ type: 'message_delta', delta: { stop_reason: n === 1 ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 10 } })
        emit({ type: 'message_stop' })
      } else {
        assert.equal(req.url, '/v1/responses')
        assert.equal(req.headers.authorization, 'Bearer fixture-key')
        assert.deepEqual(body.tools.map(tool => tool.name), ['fixture_probe'])
        const item = n === 1 ? { id: 'fc_probe', type: 'function_call', call_id: 'call_probe', name: 'fixture_probe', arguments: '{}' }
          : { id: 'msg_probe', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'VERIFIED', annotations: [] }] }
        emit({ type: 'response.created', response: { id: `resp_${n}`, status: 'in_progress', output: [] } })
        emit({ type: 'response.output_item.added', output_index: 0, item: n === 1 ? { ...item, arguments: '' } : { ...item, content: [] } })
        if (n === 1) emit({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: '{}' })
        else {
          emit({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
          emit({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'VERIFIED' })
        }
        emit({ type: 'response.output_item.done', output_index: 0, item })
        emit({ type: 'response.completed', response: { id: `resp_${n}`, status: 'completed', output: [item], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } })
      }
      res.end()
    }, { piConnection: config, keySource: 'direct', model: native ? variant === 'google-native' ? 'gemini-2.5-flash' : 'openai/gpt-4o-mini' : 'fixture' })
    let calls = 0
    const result = await runPiProcess(process.execPath, { profile: f.profile, key: 'fixture-key', directory: path.join(f.root, 'direct'),
      system: 'Use only fixture_probe.', tools: [{ name: 'fixture_probe', description: 'Harmless fixture', inputSchema: { type: 'object', properties: {} } }],
      sourceMessages: [[{ role: 'user', content: 'Call fixture_probe then reply VERIFIED.' }]], sourceOffset: 0 }, new AbortController().signal, async (message, send) => {
      if (message.type === 'lifecycle' && message.event.type === 'auto_retry_start') throw new Error(JSON.stringify(message.event))
      if (message.type === 'ready') send({ type: 'start' })
      if (message.type === 'accepted') send({ type: 'accepted' })
      if (message.type === 'tool') { calls++; assert.equal(message.name, 'fixture_probe'); send({ type: 'tool_result', id: message.id, result: 'observed' }) }
    }, process.env.TABBY_PI_FIXTURE_SIDECAR)
    assert.equal(result.text, 'VERIFIED'); assert.equal(calls, 1); assert.equal(f.requests.length, 2)
    const transcript = fs.readFileSync(result.file, 'utf8')
    assert.ok(!transcript.includes('fixture-key'))
    assert.ok(transcript.includes(native ? config.providerId : 'tabby'))
  })
}

integration('Pi native resolver retains SDK metadata, endpoint override and per-instance credentials', async () => {
  const { resolveConnection, catalogDTO, createRuntime } = await import('../artifacts/pi-resolver.mjs')
  const base = { runtime: 'pi', piConnection: { version: 1, mode: 'native', providerId: 'openrouter' }, model: 'openai/gpt-4o-mini', thinking: 'default', reasoningEffort: '', maxOutputTokens: 512 }
  const [a, b] = await Promise.all([
    resolveConnection({ ...base, baseUrl: 'http://127.0.0.1:1111/v1' }, 'connection-A'),
    resolveConnection({ ...base, baseUrl: 'http://127.0.0.1:2222/v1' }, 'connection-B'),
  ])
  assert.equal(a.model.provider, 'openrouter'); assert.equal(a.model.baseUrl, 'http://127.0.0.1:1111/v1')
  assert.equal(b.model.baseUrl, 'http://127.0.0.1:2222/v1')
  const original = (await createRuntime()).getModel('openrouter', base.model)
  assert.deepEqual(a.model.compat, original.compat)
  assert.equal(a.model.contextWindow, original.contextWindow)
  assert.equal(a.model.maxTokens, original.maxTokens)
  assert.equal((await a.runtime.getAuth(a.model)).auth.apiKey, 'connection-A')
  assert.equal((await b.runtime.getAuth(b.model)).auth.apiKey, 'connection-B')
  const catalog = catalogDTO(a.runtime)
  assert.ok(!JSON.stringify(catalog).includes('connection-A'))
  assert.match(catalog.providers.find(p => p.id === 'amazon-bedrock').unavailableReason, /identity.*dependency/)
  assert.match(catalog.providers.find(p => p.id === 'openai-codex').unavailableReason, /CLI/)
  await assert.rejects(resolveConnection({ ...base, piConnection: { ...base.piConnection, providerId: 'amazon-bedrock' } }, 'key'), /identity/)
})
