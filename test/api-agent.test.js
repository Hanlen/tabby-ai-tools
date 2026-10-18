const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const Module = require('node:module')
const ts = require('typescript')

const originalLoad = Module._load
const originalTsLoader = require.extensions['.ts']
Module._load = function (request, parent, isMain) {
  if (request === '@angular/core') return { Injectable: () => target => target, Component: () => target => target,
    Input: () => () => {}, Output: () => () => {}, ViewChild: () => () => {}, EventEmitter: require('node:events').EventEmitter }
  if (request === 'tabby-core' || request === 'tabby-terminal') return {}
  if (request === 'tabby-settings') return { SettingsTabProvider: class {} }
  if (request.endsWith('.pug') || request.endsWith('.css')) return ''
  return originalLoad.call(this, request, parent, isMain)
}
require.extensions['.ts'] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, experimentalDecorators: true,
  } }).outputText, filename)
}
const { ApiAgent } = require('../src/api-agent.ts')
const { AgentStore, profileFingerprint } = require('../src/agent-store.ts')
const { ApiProviderAdapter } = require('../src/api-provider.ts')
const { normalizeApiProfile } = require('../src/agent-types.ts')
const { ApiToolLoopGuard } = require('../src/api-loop-guard.ts')
const { apiUrl } = require('../src/api-transport.ts')
const { discoverApiModels } = require('../src/api-models.ts')
const { AgentSecretsService } = require('../src/agent-secrets.service.ts')
const { AgentBackendFactory } = require('../src/agent-backend.service.ts')
const { CodexService } = require('../src/codex.service.ts')
const { CodexPanelComponent } = require('../src/codex-panel.component.ts')
const { CodexSettingsComponent } = require('../src/settings.ts')
Module._load = originalLoad
require.extensions['.ts'] = originalTsLoader

const settings = { sandbox: 'workspace-write', approvalPolicy: 'on-request', goalTokenBudget: 0 }
const turnFinished = agent => new Promise(resolve => {
  const onEvent = event => {
    if (event.method === 'turn/completed') { agent.off('event', onEvent); resolve(event.params.turn) }
  }
  agent.on('event', onEvent)
})
const flush = () => new Promise(resolve => setImmediate(resolve))
const zone = { run: fn => fn(), runOutsideAngular: fn => fn() }
const panelTools = { releaseOwner: () => {} }

async function fixture (t, provider, handler) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tabby-api-test-'))
  const requests = []
  const errors = []
  const server = http.createServer(async (req, res) => {
    try {
      let data = ''
      for await (const part of req) data += part
      const request = { method: req.method, path: req.url, headers: req.headers, body: data ? JSON.parse(data) : undefined }
      requests.push(request)
      await handler(request, res, requests.length)
    } catch (error) { errors.push(error); res.destroy(error) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const profile = { id: 'profile-one', name: 'Test', provider, baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    model: 'test-model', apiKeyEnv: 'TEST_API_KEY', useVault: false, thinking: 'default', reasoningEffort: '',
    contextWindow: 32000, maxOutputTokens: 4096, maxIterations: 5, threads: {} }
  const store = new AgentStore(root)
  const agent = new ApiAgent(profile, store, async () => 'fixture-secret')
  t.after(async () => {
    agent.close()
    await Promise.all([...agent.running.values()].map(job => job.done))
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
    await fs.promises.rm(root, { recursive: true, force: true })
    assert.deepEqual(errors, [])
  })
  await agent.connect(settings)
  const id = await agent.openThread('/workspace', settings)
  return { root, profile, agent, id, store, requests }
}

function sse (res, events, done = true) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(': heartbeat\r\n\r\n')
  const data = events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join('') + (done ? 'data: [DONE]\r\n\r\n' : '')
  // Exercise chunk boundaries rather than assuming one HTTP chunk per event.
  for (let index = 0; index < data.length; index += 17) res.write(data.slice(index, index + 17))
  res.end()
}

function reply (provider, res, round, tool) {
  if (provider === 'openai') {
    const output = tool ? [{ type: 'reasoning', id: 'reason-' + round, encrypted_content: 'opaque-' + round, summary: [] },
      { type: 'function_call', call_id: 'call-' + round, name: tool.name, arguments: JSON.stringify(tool.args) }]
      : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完成' }] }]
    sse(res, [
      ...(!tool ? [{ type: 'response.output_text.delta', delta: '完' }, { type: 'response.output_text.delta', delta: '成' }] : []),
      { type: 'response.completed', response: { output, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
    ], false)
  } else if (provider === 'claude') {
    sse(res, [
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'native-thought-' + round } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed-' + round } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: tool ? { type: 'tool_use', id: 'call-' + round, name: tool.name, input: {} } : { type: 'text', text: '' } },
      ...(tool ? [{ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.args).slice(0, 2) } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.args).slice(2) } }]
        : [{ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '完成' } }]),
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ], false)
  } else {
    const args = tool && JSON.stringify(tool.args)
    sse(res, [
      { choices: [{ delta: { reasoning_content: 'native-thought-' + round } }] },
      ...(tool ? [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-' + round, function: { name: tool.name, arguments: args.slice(0, 2) } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(2) } }] } }] }]
        : [{ choices: [{ delta: { content: '完成' } }] }]),
      { choices: [{ delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ])
  }
}

for (const provider of ['openai', 'deepseek', 'glm', 'claude']) {
  test(`${provider}: discovers remote models with provider auth, pagination and deduplication without inference`, async t => {
    const f = await fixture(t, provider, (req, res, round) => {
      assert.equal(req.method, 'GET')
      assert.equal(req.body, undefined)
      assert.equal(req.headers[provider === 'claude' ? 'x-api-key' : 'authorization'], provider === 'claude' ? 'fixture-secret' : 'Bearer fixture-secret')
      if (provider === 'claude') assert.equal(req.headers['anthropic-version'], '2023-06-01')
      assert.equal(req.path, round === 1 ? '/v1/models' : '/v1/models?after_id=test-model')
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(round === 1 ? { data: [
        { id: 'test-model', display_name: 'Current model' },
        { id: '' }, { other: true }, null,
      ], has_more: true, last_id: 'test-model' } : { data: [
        { id: 'test-model' }, { id: 'remote-model', name: 'Remote model', effort: { supported_levels: ['low', 'high', null], default_level: 'high' } },
      ], has_more: false }))
    })
    const models = await f.agent.listModels()
    assert.deepEqual(models.map(model => model.model), ['test-model', 'remote-model'])
    assert.equal(models[0].isDefault, true)
    assert.equal(models[1].displayName, 'Remote model')
    assert.equal(models[1].isDefault, false)
    assert.equal(models[1].defaultReasoningEffort, 'high')
    assert.deepEqual(models[1].supportedReasoningEfforts.map(item => item.reasoningEffort), ['low', 'high'])
    assert.equal(f.requests.length, 2)
  })
}

test('settings discover models before a model is configured, refresh on demand and invalidate changed connections', async t => {
  const f = await fixture(t, 'deepseek', (req, res) => res.end(JSON.stringify({ data: [{ id: 'remote-model' }] })))
  const profile = { ...f.profile, model: '' }
  let refreshes = 0
  const component = new CodexSettingsComponent({ store: { codexAgent: {} }, save: async () => {} },
    { read: async () => 'fixture-secret' }, zone, { detectChanges: () => refreshes++ })
  await component.fetchModels(profile)
  assert.match(component.modelLists[profile.id].notice, /已获取 1 个模型/)
  assert.equal(component.modelLists[profile.id].running, false)
  assert.equal(component.modelLists[profile.id].models[0].model, 'remote-model')
  assert.equal(profile.model, '', 'discovery must not overwrite the chosen model')
  await component.fetchModels(profile)
  assert.equal(f.requests.length, 1, 'focusing again uses the current list')
  await component.fetchModels(profile, true)
  assert.equal(f.requests.length, 2, 'refresh explicitly queries the endpoint again')
  component.modelConnectionChanged(profile)
  assert.equal(component.modelLists[profile.id], undefined)
  await component.fetchModels(profile)
  assert.equal(f.requests.length, 3)
  assert.ok(refreshes >= 6)
  component.ngOnDestroy()
})

for (const status of [401, 403, 404, 405, 429, 302]) {
  test(`model list HTTP ${status} is visible without leaking response bodies or following redirects`, async t => {
    const f = await fixture(t, 'openai', (req, res) => {
      res.writeHead(status, { location: '/credential-leak' })
      res.end('fixture-secret sensitive response body')
    })
    const component = new CodexSettingsComponent({ store: { codexAgent: {} } }, { read: async () => 'fixture-secret' }, zone)
    await component.fetchModels(f.profile)
    const state = component.modelLists[f.profile.id]
    assert.match(state.notice, new RegExp(`获取模型列表失败.*${status}`))
    assert.equal(state.notice.includes('fixture-secret'), false)
    assert.equal(state.running, false)
    assert.equal(f.requests.length, 1)
    assert.equal(f.profile.model, 'test-model')
  })
}

for (const payload of ['<html>Proxy error with fixture-secret</html>', '{}', '{"data":[]}', '{"data":[{"id":"a"}],"has_more":true,"last_id":"a"}']) {
  test(`model discovery handles empty or invalid list: ${payload.slice(0, 24)}`, async t => {
    const f = await fixture(t, 'openai', (req, res) => res.end(payload))
    if (payload === '{"data":[]}') assert.deepEqual(await f.agent.listModels(), [])
    else await assert.rejects(f.agent.listModels(), error => /JSON|格式不兼容|分页无效/.test(error.message) && !error.message.includes('fixture-secret'))
    assert.ok(f.requests.length <= 2, 'invalid pagination must terminate')
  })
}

test('model list cancellation releases pending credentials and prevents stale settings updates', async () => {
  let readCount = 0, changes = 0
  const profile = { id: 'list-cancel', provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: '' }
  const component = new CodexSettingsComponent({ store: { codexAgent: {} }, save: async () => {} },
    { read: () => { readCount++; return new Promise(() => {}) } }, zone, { detectChanges: () => changes++ })
  const first = component.fetchModels(profile)
  const duplicate = component.fetchModels(profile, true)
  assert.equal(readCount, 1)
  component.modelConnectionChanged(profile)
  await Promise.all([first, duplicate])
  assert.equal(component.modelLists[profile.id], undefined)
  const pending = component.fetchModels(profile)
  component.ngOnDestroy()
  const atDestroy = changes
  await pending
  assert.equal(changes, atDestroy)
  assert.equal(component.fetchingModels.size, 0)
})

test('closing an API agent cancels a streaming model list request', async t => {
  let began
  const started = new Promise(resolve => { began = resolve })
  const f = await fixture(t, 'claude', (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('{"data":[')
    began()
  })
  const models = f.agent.listModels()
  const cancelled = assert.rejects(models)
  await started
  f.agent.close()
  await cancelled
  assert.equal(f.agent.modelRequest, undefined)
})

test('model discovery observes cancellation before any request and rejects unsafe Base URLs', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(discoverApiModels({ provider: 'openai', baseUrl: 'https://api.example.test/v1' },
    () => new Promise(() => {}), controller.signal), /取消或超时/)
  let reads = 0
  await assert.rejects(discoverApiModels({ provider: 'openai', baseUrl: 'https://user:secret@api.example.test/v1' },
    async () => { reads++; return 'key' }), /凭据/)
  assert.equal(reads, 0)
})

test('model picker ignores results from an older connection and retains manual model selection after errors', async () => {
  let release
  const original = { client: {}, listModels: () => new Promise(resolve => { release = resolve }) }
  const panel = new CodexPanelComponent({ store: { codexAgent: { model: 'test', reasoningEffort: 'custom' } }, save: async () => {} }, original, zone, {}, panelTools)
  const first = panel.openModelPicker()
  panel.codex = { client: {}, profile: { model: 'other' }, listModels: async () => { throw new Error('404 手动填写') } }
  await panel.openModelPicker()
  release([{ model: 'stale', displayName: 'Stale' }])
  await first
  assert.deepEqual(panel.models, [])
  assert.match(panel.modelError, /404/)
  assert.equal(panel.modelLoading, false)
  await panel.chooseModel('  manual-model  ')
  assert.equal(panel.settings.model, 'manual-model')
  assert.equal(panel.modelPickerOpen, false)
})

test('selecting a discovered API model applies it while carrying forward the conversation and goal', async t => {
  const f = await fixture(t, 'deepseek', (req, res, round) => {
    if (req.method === 'GET') { res.end(JSON.stringify({ data: [{ id: 'test-model' }, { id: 'remote-model' }] })); return }
    if (req.body.model === 'remote-model') {
      assert.equal(req.body.reasoning_effort, 'high')
      assert.ok(JSON.stringify(req.body.messages).includes('Remember before switching models'))
    }
    reply('deepseek', res, round, null)
  })
  await f.agent.setGoal(f.id, 'Keep this goal', 1000)
  let completed = turnFinished(f.agent)
  await f.agent.startTurn(f.id, 'Remember before switching models', '/workspace', settings)
  await completed
  const configured = { ...f.profile }
  const config = { store: { codexAgent: { ...settings, threads: {}, tabToolThreads: {}, apiProfiles: [configured] } }, save: async () => {} }
  let created = false, selected
  const factory = { defaultProfileId: configured.id, create: () => {
    if (!created) { created = true; return f.agent }
    selected = new ApiAgent({ ...configured }, f.store, async () => 'fixture-secret')
    return selected
  } }
  const panel = new CodexPanelComponent(config, f.agent, zone, {}, panelTools, factory)
  panel.cwd = '/workspace'; panel.threadId = f.id; panel.loading = false; panel.connected = true
  t.after(() => panel.ngOnDestroy())
  await panel.loadHistory()
  await panel.openModelPicker()
  await panel.chooseModel('remote-model', 'high')
  assert.equal(panel.connectionError, '')
  assert.equal(panel.currentModel, 'remote-model')
  assert.equal(configured.model, 'remote-model')
  assert.ok(panel.entries.some(entry => entry.text.includes('Remember before switching models')))
  assert.equal((await selected.getGoal(panel.threadId)).objective, 'Keep this goal')
  completed = turnFinished(selected)
  await selected.startTurn(panel.threadId, 'Continue with remote model', '/workspace', settings)
  assert.equal((await completed).status, 'completed')
})

for (const provider of ['openai', 'deepseek', 'glm', 'claude']) {
  test(`${provider}: streams, executes two tool rounds, preserves native reasoning and restores history`, async t => {
    const f = await fixture(t, provider, (req, res, round) => {
      assert.equal(req.path, provider === 'openai' ? '/v1/responses' : provider === 'claude' ? '/v1/messages' : '/v1/chat/completions')
      assert.equal(req.headers[provider === 'claude' ? 'x-api-key' : 'authorization'], provider === 'claude' ? 'fixture-secret' : 'Bearer fixture-secret')
      if (round > 1) {
        const messages = provider === 'openai' ? req.body.input : req.body.messages
        if (provider === 'openai') {
          assert.equal(messages.find(item => item.type === 'reasoning').encrypted_content, 'opaque-1')
          assert.equal(messages.find(item => item.type === 'function_call_output').call_id, 'call-1')
          assert.deepEqual(req.body.include, ['reasoning.encrypted_content'])
        } else if (provider === 'claude') {
          const assistant = messages.find(item => item.role === 'assistant')
          assert.equal(assistant.content[0].thinking, 'native-thought-1')
          assert.equal(assistant.content[0].signature, 'signed-1')
          assert.equal(messages.find(item => Array.isArray(item.content) && item.content[0]?.type === 'tool_result').content[0].tool_use_id, 'call-1')
        } else {
          assert.equal(messages.find(item => item.role === 'assistant').reasoning_content, 'native-thought-1')
          assert.equal(messages.find(item => item.role === 'tool').tool_call_id, 'call-1')
        }
      }
      reply(provider, res, round, round === 1 ? { name: 'list_tabs', args: {} } : round === 2 ? { name: 'read_tab', args: { tabId: 'tab-1', maxLines: 5 } } : null)
    })
    const calls = [], deltas = [], usage = []
    f.agent.on('event', event => {
      if (event.method === 'item/tool/call') {
        calls.push(event.params.tool)
        f.agent.respond(event.id, { success: true, contentItems: [{ text: JSON.stringify({ text: 'terminal output' }) }] })
      }
      if (event.method === 'item/agentMessage/delta') deltas.push(event.params.delta)
      if (event.method === 'thread/tokenUsage/updated') usage.push(event.params.tokenUsage)
    })
    await f.agent.setGoal(f.id, 'Inspect terminal', 0)
    const completed = turnFinished(f.agent)
    await f.agent.startTurn(f.id, 'Inspect terminal', '/workspace', settings)
    assert.equal((await completed).status, 'completed')
    assert.deepEqual(calls, ['list_tabs', 'read_tab'])
    assert.equal(deltas.join(''), '完成')
    assert.equal(usage.at(-1).total.totalTokens, 45)
    assert.equal(usage.at(-1).last.totalTokens, 10)
    assert.equal((await f.agent.getGoal(f.id)).status, 'active', 'end of response does not imply goal completion')
    const saved = await f.store.load(f.id)
    assert.equal(saved.messages.length > 3, true)
    assert.equal(JSON.stringify(saved).includes('fixture-secret'), false)
    const restored = new ApiAgent(f.profile, f.store, async () => 'fixture-secret')
    await restored.resumeThread(f.id, '/workspace', settings)
    assert.equal((await restored.request('thread/read', { threadId: f.id, includeTurns: true })).thread.turns[0].status, 'completed')
    assert.equal((await restored.listSessions('/workspace')).data[0].id, f.id)
    assert.equal((await restored.listSessions('/elsewhere')).data.length, 0)
    const foreign = new ApiAgent({ ...f.profile, id: 'another' }, f.store, async () => 'other')
    await assert.rejects(foreign.resumeThread(f.id, '/workspace', settings), /其他连接/)
    restored.close(); foreign.close()
  })
}

for (const decision of ['accept', 'decline']) {
  test(`terminal input requires approval: ${decision}`, async t => {
    const f = await fixture(t, 'deepseek', (req, res, round) => reply('deepseek', res, round,
      round === 1 ? { name: 'send_input', args: { tabId: 'tab-1', text: 'pwd', submit: true } } : null))
    const calls = []
    f.agent.on('event', event => {
      if (event.method === 'item/commandExecution/requestApproval') {
        calls.push('approval'); f.agent.respond(event.id, { decision })
      }
      if (event.method === 'item/tool/call') {
        calls.push('execute'); f.agent.respond(event.id, { success: true, contentItems: [{ text: 'done' }] })
      }
    })
    const completed = turnFinished(f.agent)
    await f.agent.startTurn(f.id, 'Run pwd', '/workspace', settings)
    assert.equal((await completed).status, 'completed')
    assert.deepEqual(calls, decision === 'accept' ? ['approval', 'execute'] : ['approval'])
    assert.match(f.requests[1].body.messages.find(item => item.role === 'tool').content, decision === 'accept' ? /done/ : /用户拒绝/)
  })
}

test('readonly rejects forged write tools and malformed arguments without dispatching them', async t => {
  const f = await fixture(t, 'glm', (req, res, round) => {
    assert.equal(req.body.tools.some(tool => tool.function.name === 'send_input'), false)
    reply('glm', res, round, round === 1 ? { name: 'send_input', args: { tabId: 'one', text: 'rm something' } }
      : round === 2 ? { name: 'read_tab', args: { tabId: 42 } } : null)
  })
  let dispatched = 0
  f.agent.on('event', event => { if (event.id) dispatched++ })
  const completed = turnFinished(f.agent)
  await f.agent.startTurn(f.id, 'Read', '/workspace', { ...settings, sandbox: 'read-only' })
  assert.equal((await completed).status, 'completed')
  assert.equal(dispatched, 0)
  const tools = f.requests[2].body.messages.filter(item => item.role === 'tool')
  assert.match(tools[0].content, /禁止/)
  assert.match(tools[1].content, /类型错误/)
})

test('stop cancels a pending approval and never dispatches terminal input', async t => {
  const f = await fixture(t, 'deepseek', (req, res, round) => reply('deepseek', res, round, { name: 'send_input', args: { tabId: 'one', text: 'pwd' } }))
  const approval = new Promise(resolve => f.agent.on('event', event => { if (event.method === 'item/commandExecution/requestApproval') resolve(event.id) }))
  let executed = false
  f.agent.on('event', event => { if (event.method === 'item/tool/call') executed = true })
  const completed = turnFinished(f.agent)
  const turn = await f.agent.startTurn(f.id, 'Run', '/workspace', settings)
  const request = await approval
  await f.agent.interrupt(f.id, turn)
  f.agent.respond(request, { decision: 'accept' })
  assert.equal((await completed).status, 'interrupted')
  assert.equal(executed, false)
  assert.equal(f.agent.pending.size, 0)
  assert.equal(f.requests.length, 1)
})

test('stop closes a streaming HTTP request and preserves partial output', async t => {
  let began
  const streaming = new Promise(resolve => { began = resolve })
  const f = await fixture(t, 'deepseek', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
    began()
  })
  f.profile.maxIterations = 0
  const completed = turnFinished(f.agent)
  const turn = await f.agent.startTurn(f.id, 'Test', '/workspace', settings)
  await streaming
  await f.agent.interrupt(f.id, turn)
  assert.equal((await completed).status, 'interrupted')
  assert.equal((await f.store.load(f.id)).turns[0].status, 'interrupted')
})

test('queued input reaches the next model request and is persisted', async t => {
  let release, began
  const waiting = new Promise(resolve => { began = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const f = await fixture(t, 'deepseek', async (req, res, round) => {
    if (round === 1) { began(); await gate }
    reply('deepseek', res, round, null)
  })
  const completed = turnFinished(f.agent)
  const turn = await f.agent.startTurn(f.id, 'First', '/workspace', settings)
  await waiting
  await assert.rejects(f.agent.startTurn(f.id, 'Overlapping', '/workspace', settings), /已有任务/)
  await f.agent.steer(f.id, turn, 'Then inspect logs')
  release()
  assert.equal((await completed).status, 'completed')
  assert.equal(f.requests.length, 2)
  assert.equal(f.requests[1].body.messages.at(-1).content, 'Then inspect logs')
  assert.equal((await f.store.load(f.id)).turns[0].items.some(item => item.content?.[0]?.text === 'Then inspect logs'), true)
  await assert.rejects(f.agent.steer(f.id, turn, 'too late'), /回合已结束/)
})

test('tool limits allow one closing request and token budgets stop additional model requests', async t => {
  const f = await fixture(t, 'deepseek', (req, res, round) => reply('deepseek', res, round, { name: 'list_tabs', args: {} }))
  f.agent.on('event', event => { if (event.method === 'item/tool/call') f.agent.respond(event.id, { success: true, contentItems: [{ text: '[]' }] }) })
  f.profile.maxIterations = 1
  let completed = turnFinished(f.agent)
  await f.agent.startTurn(f.id, 'Loop', '/workspace', settings)
  assert.match((await completed).error.message, /循环上限/)
  assert.equal(f.requests.length, 2)
  assert.equal(f.requests[1].body.tools, undefined)
  f.profile.maxIterations = 5
  await f.agent.setGoal(f.id, 'Budget', 10)
  completed = turnFinished(f.agent)
  await f.agent.startTurn(f.id, 'Budget', '/workspace', settings)
  assert.match((await completed).error.message, /预算/)
  assert.equal(f.requests.length, 3)
  assert.equal((await f.agent.getGoal(f.id)).status, 'budgetLimited')
})

test('tool-round normalization preserves zero, explicit limits and a bounded numeric range', () => {
  for (const [configured, expected] of [[undefined, 0], [0, 0], ['0', 0], [20, 20], [2.8, 2], [-1, 0], [200, 100], [Infinity, 0], ['bad', 0]]) {
    assert.equal(normalizeApiProfile({ provider: 'deepseek', maxIterations: configured }).maxIterations, expected)
  }
})

test('queued text responses do not consume the tool-round allowance', async t => {
  let began, release
  const waiting = new Promise(resolve => { began = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const f = await fixture(t, 'deepseek', async (req, res, round) => {
    if (round === 1) { began(); await gate }
    reply('deepseek', res, round, round === 2 ? { name: 'list_tabs', args: {} } : null)
  })
  f.profile.maxIterations = 1
  f.agent.on('event', event => {
    if (event.method === 'item/tool/call') f.agent.respond(event.id, { success: true, contentItems: [{ text: '[]' }] })
  })
  const completed = turnFinished(f.agent)
  const turn = await f.agent.startTurn(f.id, 'First', '/workspace', settings)
  await waiting
  await f.agent.steer(f.id, turn, 'Inspect terminal too')
  release()
  assert.equal((await completed).status, 'completed')
  assert.equal(f.requests.length, 3)
  assert.ok(f.requests[1].body.tools.length)
  assert.equal(f.requests[2].body.tools, undefined)
})

for (const provider of ['openai', 'deepseek', 'glm', 'claude']) {
  test(`${provider}: no fixed limit continues past the former default and keeps tool results paired`, async t => {
    const f = await fixture(t, provider, (req, res, round) => reply(provider, res, round,
      round <= 21 ? { name: 'read_tab', args: { tabId: 'tab-1', waitMs: 0 } } : null))
    f.profile.maxIterations = 0
    let calls = 0
    f.agent.on('event', event => {
      if (event.method === 'item/tool/call') {
        calls++
        f.agent.respond(event.id, { success: true, contentItems: [{ text: `progress ${calls}` }] })
      }
    })
    const completed = turnFinished(f.agent)
    await f.agent.startTurn(f.id, 'Watch progress', '/workspace', settings)
    assert.equal((await completed).status, 'completed')
    assert.equal(calls, 21)
    assert.equal(f.requests.length, 22)
    const saved = await f.store.load(f.id)
    const outputs = provider === 'openai' ? saved.messages.filter(message => message.type === 'function_call_output')
      : provider === 'claude' ? saved.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'tool_result') : [])
        : saved.messages.filter(message => message.role === 'tool')
    assert.equal(outputs.length, 21)
  })

  test(`${provider}: the last permitted goal tool can finish and receive a final response`, async t => {
    const f = await fixture(t, provider, (req, res, round) => reply(provider, res, round,
      round === 1 ? { name: 'agent_goal_update', args: { status: 'complete', evidence: 'Output and tests verified' } } : null))
    f.profile.maxIterations = 1
    await f.agent.setGoal(f.id, 'Task', 0)
    const completed = turnFinished(f.agent)
    await f.agent.startTurn(f.id, 'Task', '/workspace', settings)
    assert.equal((await completed).status, 'completed')
    assert.equal(f.requests.length, 2)
    assert.equal(f.requests[1].body.tools, undefined)
    const saved = await f.store.load(f.id)
    assert.equal(saved.goal.status, 'complete')
    assert.equal(saved.turns[0].items.at(-1).text, '完成')
  })

  test(`${provider}: the last terminal result can be verified and the goal completed while closing`, async t => {
    const f = await fixture(t, provider, (req, res, round) => {
      if (round === 2) assert.deepEqual(req.body.tools.map(tool => tool.name || tool.function?.name), ['agent_goal_update'])
      if (round === 3) assert.equal(req.body.tools, undefined)
      reply(provider, res, round, round === 1 ? { name: 'read_tab', args: { tabId: 'one', waitMs: 0 } }
        : round === 2 ? { name: 'agent_goal_update', args: { status: 'complete', evidence: 'Last terminal result confirms all tests passed' } } : null)
    })
    f.profile.maxIterations = 1
    await f.agent.setGoal(f.id, 'Verify tests', 0)
    let calls = 0
    f.agent.on('event', event => {
      if (event.method === 'item/tool/call') {
        calls++
        f.agent.respond(event.id, { success: true, contentItems: [{ text: 'all tests passed' }] })
      }
    })
    const completed = turnFinished(f.agent)
    await f.agent.startTurn(f.id, 'Task', '/workspace', settings)
    assert.equal((await completed).status, 'completed')
    assert.equal(calls, 1)
    assert.equal(f.requests.length, 3)
    assert.equal((await f.store.load(f.id)).goal.status, 'complete')
  })

  test(`${provider}: the closing response cannot dispatch more tools or falsely complete an active goal`, async t => {
    const f = await fixture(t, provider, (req, res, round) => reply(provider, res, round,
      round === 1 ? { name: 'list_tabs', args: {} } : { name: 'send_input', args: { tabId: 'one', text: 'dangerous', submit: true } }))
    f.profile.maxIterations = 1
    await f.agent.setGoal(f.id, 'Unfinished', 0)
    const calls = []
    f.agent.on('event', event => {
      if (event.id) {
        calls.push(event.params.tool)
        f.agent.respond(event.id, { success: true, contentItems: [{ text: '[]' }] })
      }
    })
    const completed = turnFinished(f.agent)
    await f.agent.startTurn(f.id, 'Task', '/workspace', settings)
    const turn = await completed
    assert.equal(turn.status, 'failed')
    assert.match(turn.error.message, /循环上限/)
    assert.deepEqual(calls, ['list_tabs'])
    assert.equal(f.requests.length, 2)
    const saved = await f.store.load(f.id)
    assert.equal(saved.goal.status, 'active')
    assert.equal(JSON.stringify(saved.messages).includes('dangerous'), false)
  })
}

test('a closing summary preserves the last result without marking an unfinished goal complete', async t => {
  const f = await fixture(t, 'deepseek', (req, res, round) => reply('deepseek', res, round,
    round === 1 ? { name: 'list_tabs', args: {} } : null))
  f.profile.maxIterations = 1
  await f.agent.setGoal(f.id, 'Unfinished', 0)
  f.agent.on('event', event => {
    if (event.method === 'item/tool/call') f.agent.respond(event.id, { success: true, contentItems: [{ text: 'last observed result' }] })
  })
  const completed = turnFinished(f.agent)
  await f.agent.startTurn(f.id, 'Task', '/workspace', settings)
  assert.equal((await completed).status, 'failed')
  assert.equal(f.requests[1].body.messages.at(-1).content, 'last observed result')
  const saved = await f.store.load(f.id)
  assert.equal(saved.goal.status, 'active')
  assert.equal(saved.messages.some(message => message.role === 'assistant' && message.content === '完成'), true)
})

test('closing permits only one goal update even if the model keeps calling it', async t => {
  const f = await fixture(t, 'deepseek', (req, res, round) => reply('deepseek', res, round,
    round === 1 ? { name: 'list_tabs', args: {} } : { name: 'agent_goal_update', args: { status: 'active', evidence: 'More work remains' } }))
  f.profile.maxIterations = 1
  await f.agent.setGoal(f.id, 'Unfinished', 0)
  f.agent.on('event', event => {
    if (event.method === 'item/tool/call') f.agent.respond(event.id, { success: true, contentItems: [{ text: '[]' }] })
  })
  const completed = turnFinished(f.agent)
  await f.agent.startTurn(f.id, 'Task', '/workspace', settings)
  assert.match((await completed).error.message, /循环上限/)
  assert.equal(f.requests.length, 3)
  assert.equal(f.requests[2].body.tools, undefined)
  assert.equal((await f.store.load(f.id)).goal.status, 'active')
})

test('unlimited mode still stops at token budgets before executing another round', async t => {
  const f = await fixture(t, 'deepseek', (req, res, round) => reply('deepseek', res, round, { name: 'list_tabs', args: {} }))
  f.profile.maxIterations = 0
  await f.agent.setGoal(f.id, 'Budget', 10)
  f.agent.on('event', event => {
    if (event.method === 'item/tool/call') f.agent.respond(event.id, { success: true, contentItems: [{ text: '[]' }] })
  })
  const completed = turnFinished(f.agent)
  await f.agent.startTurn(f.id, 'Task', '/workspace', settings)
  assert.match((await completed).error.message, /预算/)
  assert.equal(f.requests.length, 1)
  assert.equal((await f.agent.getGoal(f.id)).status, 'budgetLimited')
})

test('loop evidence includes non-adjacent A/B/C cycles and survives a saved-state round trip', () => {
  let guard = new ApiToolLoopGuard()
  let evidence
  for (let index = 0; index < 9; index++) {
    if (index === 6) guard = new ApiToolLoopGuard(JSON.parse(JSON.stringify(guard.state)))
    const plan = ['A', 'B', 'C'][index % 3]
    evidence = guard.record({ id: `call-${index}`, name: 'send_input', arguments: JSON.stringify({ text: plan, tabId: 'one', purpose: `explanation ${index}` }) },
      { id: `call-${index}`, result: JSON.stringify(index % 2 ? { error: plan, sent: false } : { sent: false, error: plan }) })
    if (index < 8) assert.equal(evidence, undefined)
  }
  assert.equal(evidence.period, 3)
  assert.equal(evidence.repeats, 3)
  assert.equal(evidence.actions.length, 3)
  assert.ok(guard.before({ id: 'next', name: 'send_input', arguments: '{"tabId":"one","text":"A"}' }))
  assert.equal(guard.before({ id: 'different', name: 'send_input', arguments: '{"tabId":"one","text":"D"}' }), undefined)
  assert.equal(guard.before({ id: 'inspect', name: 'read_tab', arguments: '{"tabId":"one"}' }), undefined)
})

test('repeating failures remain detectable while terminal scrollback grows', () => {
  const guard = new ApiToolLoopGuard()
  let text = '', evidence
  for (let index = 0; index < 9; index++) {
    const plan = ['A', 'B', 'C'][index % 3]
    assert.equal(guard.record({ id: `send-${index}`, name: 'send_input', arguments: JSON.stringify({ tabId: 'one', text: plan, submit: true }) },
      { id: `send-${index}`, result: '{"sent":true}' }), undefined)
    text += `${plan} failed\n`
    evidence = guard.record({ id: `read-${index}`, name: 'read_tab', arguments: JSON.stringify({ tabId: 'one', waitMs: index * 1000 }) },
      { id: `read-${index}`, result: JSON.stringify({ text, runningProcesses: [], controlledByAI: false }) })
    if (index < 8) assert.equal(evidence, undefined)
  }
  assert.equal(evidence.period, 6)
})

test('live or unknown terminal waits and changing results are not loop evidence', () => {
  for (const runningProcesses of [null, ['build']]) {
    const guard = new ApiToolLoopGuard()
    for (let index = 0; index < 12; index++) {
      assert.equal(guard.record({ id: `read-${index}`, name: 'read_tab', arguments: '{"tabId":"one"}' },
        { id: `read-${index}`, result: JSON.stringify({ text: 'still compiling', runningProcesses }) }), undefined)
    }
  }
  const guard = new ApiToolLoopGuard()
  for (let index = 0; index < 12; index++) {
    assert.equal(guard.record({ id: `call-${index}`, name: 'read_tab', arguments: '{"tabId":"one"}' },
      { id: `call-${index}`, result: JSON.stringify({ text: `progress ${index}`, runningProcesses: [] }) }), undefined)
  }
  const acknowledgements = new ApiToolLoopGuard()
  for (let index = 0; index < 12; index++) {
    assert.equal(acknowledgements.record({ id: `call-${index}`, name: 'send_input', arguments: '{"tabId":"one","text":"yes","mode":"stdin","submit":true}' },
      { id: `call-${index}`, result: '{"sent":true}' }), undefined)
  }
})

test('longer cycles are detected within the bounded observation window', () => {
  const guard = new ApiToolLoopGuard()
  let evidence
  for (let index = 0; index < 60; index++) {
    evidence = guard.record({ id: `call-${index}`, name: 'send_input', arguments: JSON.stringify({ tabId: 'one', text: `step ${index % 20}` }) },
      { id: `call-${index}`, result: 'failed', error: true })
    if (index < 59) assert.equal(evidence, undefined)
  }
  assert.equal(evidence.period, 20)
  assert.equal(guard.state.observations.length, 60)
})

for (const provider of ['openai', 'deepseek', 'glm', 'claude']) {
  test(`${provider}: repeated A/B/C outcomes stop tools and block the goal even without a fixed limit`, { timeout: 5000 }, async t => {
    const f = await fixture(t, provider, (req, res, round) => {
      reply(provider, res, round, round <= 9 ? { name: 'send_input', args: { tabId: 'one', text: ['A', 'B', 'C'][(round - 1) % 3], submit: true } } : null)
    })
    f.profile.maxIterations = 0
    await f.agent.setGoal(f.id, 'Task with three failed approaches', 0)
    const calls = []
    f.agent.on('event', event => {
      if (event.method === 'item/tool/call') {
        calls.push(event.params.arguments.text)
        f.agent.respond(event.id, { success: false, contentItems: [{ text: 'approach failed' }] })
      }
    })
    const completed = turnFinished(f.agent)
    await f.agent.startTurn(f.id, 'Task', '/workspace', { ...settings, approvalPolicy: 'never' })
    const turn = await completed
    assert.equal(turn.status, 'failed')
    assert.match(turn.error.message, /重复工具循环/)
    assert.match(turn.error.message, /3 步/)
    assert.equal(calls.length, 9)
    assert.equal(f.requests.length, 10)
    assert.equal(f.requests.at(-1).body.tools, undefined)
    const saved = await f.store.load(f.id)
    assert.equal(saved.goal.status, 'blocked')
    assert.equal(saved.toolLoopState.observations.length, 9)
    await f.agent.setGoal(f.id, 'A different task', 0)
    assert.equal((await f.store.load(f.id)).toolLoopState, undefined)
  })
}

test('a detected loop blocks the rest of the same tool batch while preserving every result pairing', async t => {
  const f = await fixture(t, 'deepseek', (req, res, round) => {
    if (round > 1) { reply('deepseek', res, round, null); return }
    sse(res, [{ choices: [{ delta: { tool_calls: Array.from({ length: 10 }, (_, index) => ({
      index, id: `batch-${index}`, function: { name: 'send_input', arguments: JSON.stringify({ tabId: 'one', text: ['A', 'B', 'C'][index % 3], submit: true }) },
    })) } }] }, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }])
  })
  f.profile.maxIterations = 0
  let dispatched = 0
  f.agent.on('event', event => {
    if (event.method === 'item/tool/call') {
      dispatched++
      f.agent.respond(event.id, { success: false, contentItems: [{ text: 'failed' }] })
    }
  })
  const completed = turnFinished(f.agent)
  await f.agent.startTurn(f.id, 'Task', '/workspace', { ...settings, approvalPolicy: 'never' })
  assert.match((await completed).error.message, /重复工具循环/)
  assert.equal(dispatched, 9)
  const results = f.requests[1].body.messages.filter(message => message.role === 'tool')
  assert.equal(results.length, 10)
  assert.deepEqual(results.map(result => result.tool_call_id), Array.from({ length: 10 }, (_, index) => `batch-${index}`))
  assert.match(results.at(-1).content, /重复工具循环/)
})

test('restoring a stopped loop prevents replaying the same command before another terminal dispatch', async t => {
  const f = await fixture(t, 'deepseek', (req, res, round) => reply('deepseek', res, round,
    round <= 9 || round === 11 ? { name: 'send_input', args: { tabId: 'one', text: round === 11 ? 'A' : ['A', 'B', 'C'][(round - 1) % 3], submit: true } } : null))
  f.profile.maxIterations = 0
  await f.agent.setGoal(f.id, 'Task', 0)
  let dispatched = 0
  f.agent.on('event', event => {
    if (event.method === 'item/tool/call') {
      dispatched++
      f.agent.respond(event.id, { success: false, contentItems: [{ text: 'failed' }] })
    }
  })
  let completed = turnFinished(f.agent)
  await f.agent.startTurn(f.id, 'Task', '/workspace', { ...settings, approvalPolicy: 'never' })
  assert.match((await completed).error.message, /重复工具循环/)
  assert.equal(dispatched, 9)
  const restored = new ApiAgent(f.profile, f.store, async () => 'fixture-secret')
  t.after(() => restored.close())
  await restored.resumeThread(f.id, '/workspace', settings)
  restored.on('event', event => {
    if (event.method === 'item/tool/call') {
      dispatched++
      restored.respond(event.id, { success: false, contentItems: [{ text: 'failed' }] })
    }
  })
  completed = turnFinished(restored)
  await restored.startTurn(f.id, 'Continue', '/workspace', { ...settings, approvalPolicy: 'never' })
  assert.match((await completed).error.message, /重复工具循环/)
  assert.equal(dispatched, 9)
})

test('goal completion is explicit and persisted', async t => {
  const f = await fixture(t, 'openai', (req, res, round) => reply('openai', res, round,
    round === 1 ? { name: 'agent_goal_update', args: { status: 'complete', evidence: 'Tests passed and output checked' } } : null))
  await f.agent.setGoal(f.id, 'Task', 0)
  const completed = turnFinished(f.agent)
  await f.agent.startTurn(f.id, 'Task', '/workspace', settings)
  assert.equal((await completed).status, 'completed')
  assert.equal((await f.store.load(f.id)).goal.status, 'complete')
})

test('recovery interrupts unfinished turns; changed endpoints carry portable context into a new session', async t => {
  const f = await fixture(t, 'deepseek', (req, res, round) => reply('deepseek', res, round, null))
  const session = await f.store.load(f.id)
  session.turns.push({ id: 'old-turn', status: 'inProgress', items: [{ type: 'commandExecution', command: 'send_input pwd', aggregatedOutput: 'unknown' }] })
  await f.store.save(session)
  await f.agent.resumeThread(f.id, '/workspace', settings)
  const recovered = await f.store.load(f.id)
  assert.equal(recovered.turns[0].status, 'interrupted')
  assert.match(recovered.messages.at(-1).content, /禁止自动重放/)
  assert.equal(f.requests.length, 0)
  const changed = new ApiAgent({ ...f.profile, baseUrl: f.profile.baseUrl + '/other' }, f.store, async () => 'key')
  const migratedId = await changed.openThread('/workspace', settings, f.id)
  assert.notEqual(migratedId, f.id)
  const migrated = await f.store.load(migratedId)
  assert.deepEqual(migrated.turns, recovered.turns)
  assert.match(migrated.messages.at(-1).content, /禁止自动重放/)
  await assert.rejects(changed.resumeThread(f.id, '/workspace', settings), /其他连接/)
  changed.close()
})

test('corrupted history is reported rather than overwritten', async t => {
  const f = await fixture(t, 'deepseek', (req, res, round) => reply('deepseek', res, round, null))
  const file = path.join(f.root, f.id + '.json')
  await fs.promises.writeFile(file, '{invalid json')
  await assert.rejects(f.agent.openThread('/workspace', settings, f.id), SyntaxError)
  assert.equal(await fs.promises.readFile(file, 'utf8'), '{invalid json')
  await assert.rejects(f.store.load('../outside'), /无效/)
})

for (const [name, events] of [
  ['truncated stream', [{ choices: [{ delta: { content: 'partial' } }] }]],
  ['output limit', [{ choices: [{ delta: {}, finish_reason: 'length' }] }]],
  ['provider error', [{ error: { message: 'fixture-secret private request' } }]],
]) {
  test(`${name} ends as failed with no implicit retry`, async t => {
    const f = await fixture(t, 'deepseek', (req, res) => sse(res, events))
    const completed = turnFinished(f.agent)
    await f.agent.startTurn(f.id, 'Test', '/workspace', settings)
    const turn = await completed
    assert.equal(turn.status, 'failed')
    assert.equal(turn.error.message.includes('fixture-secret'), false)
    assert.equal(f.requests.length, 1)
  })
}

test('HTTP errors redact bodies and never follow credential-bearing redirects', async t => {
  const f = await fixture(t, 'deepseek', (req, res) => { res.writeHead(302, { location: '/stolen' }); res.end('fixture-secret') })
  const completed = turnFinished(f.agent)
  await f.agent.startTurn(f.id, 'Test', '/workspace', settings)
  const turn = await completed
  assert.match(turn.error.message, /HTTP 302/)
  assert.equal(turn.error.message.includes('fixture-secret'), false)
  assert.equal(f.requests.length, 1)
  assert.throws(() => apiUrl('http://example.com', 'messages'), /HTTPS/)
  assert.throws(() => apiUrl('https://user:pass@example.com', 'messages'), /凭据/)
})

test('API credentials accept explicit direct input and preserve legacy environment/Vault sources', async () => {
  const secretRecords = []
  const vault = { isEnabled: () => false, getSecret: async () => null,
    addSecret: async secret => secretRecords.push(secret), updateSecret: async (old, secret) => secretRecords.push(secret) }
  const secrets = new AgentSecretsService(vault)
  assert.equal(await secrets.read({ keySource: 'direct', apiKey: ' direct-secret ', useVault: true }), 'direct-secret')
  await assert.rejects(secrets.read({ keySource: 'direct', apiKey: ' ' }), /填写 API Key/)
  await assert.rejects(secrets.read({ keySource: 'environment', apiKey: 'unused', apiKeyEnv: 'TABBY_AGENT_TEST_MISSING_KEY' }), /未设置环境变量/)
  await assert.rejects(secrets.read({ useVault: false, apiKeyEnv: 'TABBY_AGENT_TEST_MISSING_KEY' }), /未设置环境变量/)
  await assert.rejects(secrets.save({ id: 'one' }, 'secret'), /启用 Vault/)
  vault.isEnabled = () => true
  await secrets.save({ id: 'one' }, 'secret')
  assert.deepEqual(secretRecords[0].key, { profileId: 'one' })
  vault.getSecret = async () => secretRecords[0]
  assert.equal(await secrets.read({ id: 'one', useVault: true }), 'secret')
})

for (const source of ['openai', 'deepseek', 'glm', 'claude']) {
  for (const target of ['openai', 'deepseek', 'glm', 'claude']) {
    test(`context handoff ${source} → ${target} keeps messages, tools, goal and restart history`, async t => {
      const first = await fixture(t, source, (req, res, round) => reply(source, res, round,
        round === 1 ? { name: 'read_tab', args: { tabId: 'one' } } : null))
      first.agent.on('event', event => {
        if (event.method === 'item/tool/call') first.agent.respond(event.id, { success: true, contentItems: [{ text: 'original terminal result' }] })
      })
      await first.agent.setGoal(first.id, 'Keep this task objective', 5000)
      let completed = turnFinished(first.agent)
      await first.agent.startTurn(first.id, 'Remember the original request', '/workspace', settings, 'original forwarded terminal output')
      assert.equal((await completed).status, 'completed')
      const context = await first.agent.exportContext(first.id)
      const second = await fixture(t, target, (req, res, round) => {
        const messages = target === 'openai' ? req.body.input : req.body.messages.filter(message => message.role !== 'system')
        assert.equal(messages.every(message => ['user', 'assistant'].includes(message.role) && typeof message.content === 'string'), true)
        const wire = JSON.stringify(messages)
        for (const text of ['Remember the original request', 'original forwarded terminal output', 'read_tab', 'original terminal result', '完成', 'Continue after switching']) assert.equal(wire.includes(text), true, text)
        for (const privateValue of ['native-thought-', 'opaque-', 'signed-', 'tool_calls', 'encrypted_content', 'fixture-secret']) assert.equal(wire.includes(privateValue), false, privateValue)
        if (target === 'deepseek') assert.equal(messages.filter(message => message.role === 'assistant').every(message => message.reasoning_content === ''), true)
        assert.match(req.body.instructions || req.body.system || req.body.messages[0].content, /Keep this task objective/)
        reply(target, res, round, null)
      })
      // Each fixture has its own store; exercise actual persistence in the target store.
      const transferred = await second.agent.importContext(context, '/workspace', settings)
      assert.notEqual(transferred, first.id)
      assert.deepEqual((await second.store.load(transferred)).turns, (await first.store.load(first.id)).turns)
      const restored = new ApiAgent(second.profile, second.store, async () => 'fixture-secret')
      t.after(() => restored.close())
      await restored.resumeThread(transferred, '/workspace', settings)
      assert.deepEqual(await restored.getGoal(transferred), await first.agent.getGoal(first.id))
      completed = turnFinished(restored)
      await restored.startTurn(transferred, 'Continue after switching', '/workspace', settings)
      assert.equal((await completed).status, 'completed')
      assert.equal((await second.store.load(transferred)).totalTokens, 45)
      assert.equal((await first.store.load(first.id)).turns.length, 1, 'source history remains intact')
    })
  }
}

test('changing a model keeps context and goals; an unchanged reconnect retains native messages', async t => {
  const f = await fixture(t, 'claude', (req, res, round) => reply('claude', res, round, null))
  await f.agent.setGoal(f.id, 'Finish original task', 100)
  const completed = turnFinished(f.agent)
  await f.agent.startTurn(f.id, 'Original question', '/workspace', settings)
  assert.equal((await completed).status, 'completed')
  const original = await f.store.load(f.id)
  const same = new ApiAgent({ ...f.profile, apiKey: 'new-key' }, f.store, async () => 'new-key')
  assert.equal(await same.openThread('/workspace', settings, f.id), f.id)
  assert.deepEqual((await f.store.load(f.id)).messages, original.messages)
  const changed = new ApiAgent({ ...f.profile, model: 'another-model' }, f.store, async () => 'key')
  const id = await changed.openThread('/workspace', settings, f.id)
  const migrated = await f.store.load(id)
  assert.notEqual(id, f.id)
  assert.deepEqual(migrated.turns, original.turns)
  assert.deepEqual(migrated.goal, original.goal)
  assert.deepEqual(migrated.messages, [{ role: 'user', content: 'Original question' }, { role: 'assistant', content: '完成' }])
  await assert.rejects(changed.importContext(await f.agent.exportContext(f.id), '/elsewhere', settings), /工作目录/)
  same.close(); changed.close()
})

test('directly entered API keys work without Vault and never enter transferred or saved history', async t => {
  const f = await fixture(t, 'deepseek', (req, res, round) => {
    assert.equal(req.headers.authorization, 'Bearer entered-secret')
    reply('deepseek', res, round, null)
  })
  const secrets = new AgentSecretsService({ isEnabled: () => false, getSecret: () => { throw new Error('Vault must not be read') } })
  f.profile.keySource = 'direct'
  f.profile.apiKey = 'entered-secret'
  f.agent.getKey = () => secrets.read(f.profile)
  const completed = turnFinished(f.agent)
  await f.agent.startTurn(f.id, 'Test directly entered key', '/workspace', settings)
  assert.equal((await completed).status, 'completed')
  assert.equal(JSON.stringify(await f.store.load(f.id)).includes('entered-secret'), false)
  assert.equal(JSON.stringify(await f.agent.exportContext(f.id)).includes('entered-secret'), false)
})

test('factory keeps Codex and each API backend independent and uses the Tabby config directory', async () => {
  const profile = { id: 'test', provider: 'glm', baseUrl: '', model: 'glm-test', threads: {} }
  const codex = { marker: 'codex' }
  const factory = new AgentBackendFactory({ store: { codexAgent: { apiProfiles: [profile], defaultProfileId: 'test' } } }, codex,
    { read: async () => 'secret' }, { getConfigPath: () => path.join(os.tmpdir(), 'tabby', 'config.yaml') })
  assert.equal(factory.defaultProfileId, 'test')
  assert.equal(factory.create(''), codex)
  const first = factory.create('test'), second = factory.create('test')
  assert.notEqual(first, second)
  assert.equal(first.profile.baseUrl, 'https://open.bigmodel.cn/api/paas/v4')
  assert.equal(first.store.root, path.join(os.tmpdir(), 'tabby', 'tabby-agent-sessions'))
  profile.model = 'another-model'
  assert.equal(first.profile.model, 'glm-test')
  assert.notEqual(profileFingerprint(first.profile), profileFingerprint(factory.create('test').profile))
  first.close(); second.close()
})

test('stop does not wait for an unresolved Vault prompt or make an API request', async t => {
  const f = await fixture(t, 'claude', (req, res, round) => reply('claude', res, round, null))
  f.agent.getKey = () => new Promise(() => {})
  const completed = turnFinished(f.agent)
  const turn = await f.agent.startTurn(f.id, 'Test', '/workspace', settings)
  await f.agent.interrupt(f.id, turn)
  assert.equal((await completed).status, 'interrupted')
  assert.equal(f.requests.length, 0)
})

test('missing usage stays unknown and an OpenAI final item still renders without delta events', async t => {
  const f = await fixture(t, 'openai', (req, res) => sse(res, [
    { type: 'response.completed', response: { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Full final response' }] }] } },
  ], false))
  const events = []
  f.agent.on('event', event => events.push(event))
  const completed = turnFinished(f.agent)
  await f.agent.startTurn(f.id, 'Test', '/workspace', settings)
  assert.equal((await completed).status, 'completed')
  assert.equal(events.some(event => event.method === 'thread/tokenUsage/updated'), false)
  assert.equal(events.find(event => event.method === 'item/completed').params.item.text, 'Full final response')
})

test('Claude counts cached input in context usage and rejects a missing message_stop', async t => {
  const f = await fixture(t, 'claude', (req, res, round) => sse(res, [
    { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Final' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    ...(round === 1 ? [{ type: 'message_stop' }] : []),
  ], false))
  let usage
  f.agent.on('event', event => { if (event.method === 'thread/tokenUsage/updated') usage = event.params.tokenUsage })
  let completed = turnFinished(f.agent)
  await f.agent.startTurn(f.id, 'Test', '/workspace', settings)
  assert.equal((await completed).status, 'completed')
  assert.equal(usage.last.totalTokens, 160)
  assert.equal(usage.total.totalTokens, 165)
  completed = turnFinished(f.agent)
  await f.agent.startTurn(f.id, 'Again', '/workspace', settings)
  assert.equal((await completed).status, 'failed')
})

test('test connection makes a real streaming request, renders progress inline and prevents duplicate requests', { timeout: 5000 }, async t => {
  let releaseThinking, releaseText, sawThinking, sawText
  const thinkingGate = new Promise(resolve => { releaseThinking = resolve })
  const textGate = new Promise(resolve => { releaseText = resolve })
  const thinkingShown = new Promise(resolve => { sawThinking = resolve })
  const textShown = new Promise(resolve => { sawText = resolve })
  t.after(() => { releaseThinking(); releaseText() })
  const f = await fixture(t, 'deepseek', async (req, res) => {
    assert.equal(req.body.stream, true)
    assert.equal(req.body.tools, undefined, 'connection tests must not allow tool execution')
    assert.equal(req.body.reasoning_effort, 'high')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"reasoning_content":"thinking chunk"}}]}\n\n')
    await thinkingGate
    res.write('data: {"choices":[{"delta":{"content":"O"}}]}\n\n')
    await textGate
    res.end('data: {"choices":[{"delta":{"content":"K"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  })
  f.profile.reasoningEffort = 'high'
  let component
  component = new CodexSettingsComponent({ store: { codexAgent: {} } }, { read: async () => 'fixture-secret' }, zone, {
    detectChanges: () => {
      const status = component.connectionTests[f.profile.id]
      if (status?.notice.includes('正在思考')) sawThinking()
      if (status?.notice.includes('流式回复')) sawText()
    },
  })
  let finished = false
  const checked = component.testProfile(f.profile).then(() => { finished = true })
  assert.equal(component.connectionTests[f.profile.id].running, true)
  await thinkingShown
  assert.equal(finished, false, 'thinking progress must be visible before completion')
  await component.testProfile(f.profile)
  assert.equal(f.requests.length, 1)
  releaseThinking()
  await textShown
  assert.equal(finished, false, 'text progress must be visible before completion')
  releaseText()
  await checked
  assert.equal(component.connectionTests[f.profile.id].running, false)
  assert.match(component.connectionTests[f.profile.id].notice, /测试成功.*2 个正文流片段/)
  component.ngOnDestroy()
})

test('test connection reports auth errors locally without exposing response bodies or API keys', async t => {
  const f = await fixture(t, 'deepseek', (req, res) => { res.writeHead(401); res.end('fixture-secret private data') })
  const component = new CodexSettingsComponent({ store: { codexAgent: {} } }, { read: async () => 'fixture-secret' }, zone)
  await component.testProfile(f.profile)
  assert.match(component.connectionTests[f.profile.id].notice, /测试失败.*401.*密钥无效/)
  assert.equal(component.connectionTests[f.profile.id].notice.includes('fixture-secret'), false)
  assert.equal(component.connectionTests[f.profile.id].running, false)
  assert.equal(f.requests.length, 1)
})

test('test connection cancellation unblocks credential prompts and destruction skips view updates', async () => {
  let refreshes = 0
  const component = new CodexSettingsComponent({ store: { codexAgent: {} } }, { read: () => new Promise(() => {}) }, zone, { detectChanges: () => refreshes++ })
  const profile = { id: 'cancel', provider: 'deepseek', model: 'test', baseUrl: 'https://api.deepseek.com' }
  let checked = component.testProfile(profile)
  component.cancelTest(profile)
  await checked
  assert.match(component.connectionTests.cancel.notice, /取消或超时/)
  checked = component.testProfile(profile)
  component.ngOnDestroy()
  const atDestroy = refreshes
  await checked
  assert.equal(refreshes, atDestroy)
  assert.equal(component.testing.size, 0)
})

test('DeepSeek text renders at the first delayed SSE chunk before the request completes', { timeout: 5000 }, async t => {
  let release, showed
  const gate = new Promise(resolve => { release = resolve })
  const visible = new Promise(resolve => { showed = resolve })
  t.after(() => release())
  const f = await fixture(t, 'deepseek', async (req, res) => {
    assert.equal(req.body.stream, true)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"reasoning_content":"private reasoning"}}]}\n\n')
    res.write('data: {"choices":[{"delta":{"content":"first piece"}}]}\n\n')
    await gate
    res.end('data: {"choices":[{"delta":{"content":" last piece"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  })
  let panel
  panel = new CodexPanelComponent({ store: { codexAgent: { threads: {} } } }, f.agent, zone, {}, panelTools, undefined, {
    detectChanges: () => { if (panel.entries.some(entry => entry.text === 'first piece')) showed() },
  })
  panel.threadId = f.id
  panel.loading = false
  f.agent.on('event', panel.onEvent)
  t.after(() => panel.ngOnDestroy())
  let done = false
  const completed = turnFinished(f.agent).then(result => { done = true; return result })
  await f.agent.startTurn(f.id, 'Stream output', '/workspace', settings)
  await visible
  assert.equal(done, false)
  assert.equal(panel.entries.some(entry => entry.text.includes('private reasoning')), false)
  assert.equal(panel.status, '正在接收回复…')
  release()
  assert.equal((await completed).status, 'completed')
  assert.equal(panel.entries.find(entry => entry.kind === 'agent').text, 'first piece last piece')
})

test('DeepSeek Thinking switch and effort are sent on the next turn without reconnecting or losing messages', async t => {
  const f = await fixture(t, 'deepseek', (req, res, round) => {
    if (req.method === 'GET') { res.end(JSON.stringify({ data: [{ id: 'test-model' }] })); return }
    assert.equal(req.body.thinking.type, round === 1 ? 'enabled' : 'disabled')
    assert.equal(req.body.reasoning_effort, round === 1 ? 'max' : undefined)
    reply('deepseek', res, round, null)
  })
  const configured = { ...f.profile }
  const panel = new CodexPanelComponent({ store: { codexAgent: { threads: {}, apiProfiles: [configured] } }, save: async () => {} }, f.agent, zone, {}, panelTools)
  panel.profileId = configured.id
  panel.threadId = f.id
  panel.loading = false
  panel.entries = [{ id: 'existing', kind: 'user', text: 'Existing message' }]
  await panel.setApiThinking('enabled', 'max')
  assert.equal(f.agent.profile.reasoningEffort, 'max')
  assert.equal(panel.threadId, f.id)
  assert.equal(panel.entries[0].text, 'Existing message')
  let completed = turnFinished(f.agent)
  await f.agent.startTurn(f.id, 'First question', '/workspace', settings)
  assert.equal((await completed).status, 'completed')
  await panel.setApiThinking('disabled', 'max')
  completed = turnFinished(f.agent)
  await f.agent.startTurn(f.id, 'Second question', '/workspace', settings)
  assert.equal((await completed).status, 'completed')
  assert.equal(f.requests[1].body.messages.some(message => message.content === 'First question'), true)
  assert.deepEqual((await f.agent.listModels())[0].supportedReasoningEfforts.map(effort => effort.reasoningEffort), ['low', 'high', 'max'])
})

test('DeepSeek → Codex → DeepSeek preserves displayed history, model context, goals and per-provider model settings', async t => {
  const f = await fixture(t, 'deepseek', (req, res, round) => {
    if (round > 1) {
      const wire = JSON.stringify(req.body.messages)
      for (const text of ['Original DS request', 'forwarded original terminal', 'Codex follow-up', 'Codex answer']) assert.equal(wire.includes(text), true, text)
    }
    reply('deepseek', res, round, null)
  })
  await f.agent.setGoal(f.id, 'Shared task goal', 1000)
  let completed = turnFinished(f.agent)
  await f.agent.startTurn(f.id, 'Original DS request', '/workspace', settings, 'forwarded original terminal')
  assert.equal((await completed).status, 'completed')
  const codex = new CodexService()
  codex.setContextStore(f.store)
  codex.connect = async () => {}
  let nativeTurns = [], savedGoal, seed
  codex.client.request = async (method, params) => {
    if (method === 'thread/start') {
      assert.equal(params.model, 'codex-native', 'Codex must not inherit the API model ID')
      seed = params.developerInstructions
      return { thread: { id: 'codex-seeded' }, model: 'codex-native' }
    }
    if (method === 'thread/resume') return { thread: { id: params.threadId }, model: 'codex-native' }
    if (method === 'thread/goal/set') { savedGoal = { ...params, tokensUsed: 0 }; return { goal: savedGoal } }
    if (method === 'thread/goal/get') return { goal: savedGoal }
    if (method === 'thread/read') return { thread: { id: params.threadId, cwd: '/workspace', historyMode: 'paginated', status: { type: 'idle' } } }
    if (method === 'thread/turns/list') return { data: nativeTurns.slice().reverse(), nextCursor: null }
    throw new Error(`Unexpected method: ${method}`)
  }
  const config = { store: { codexAgent: { ...settings, executable: 'codex', model: 'codex-native', reasoningEffort: 'high', threads: {}, tabToolThreads: {}, apiProfiles: [f.profile] } }, save: async () => {} }
  let created = false, returned
  const factory = { defaultProfileId: f.profile.id, create: id => {
    if (!id) return codex
    if (!created) { created = true; return f.agent }
    returned = new ApiAgent({ ...f.profile }, f.store, async () => 'fixture-secret')
    return returned
  } }
  const panel = new CodexPanelComponent(config, codex, zone, {}, panelTools, factory)
  panel.cwd = '/workspace'; panel.threadId = f.id; panel.loading = false; panel.connected = true
  t.after(() => panel.ngOnDestroy())
  await panel.loadHistory()
  await panel.selectConnection('')
  assert.equal(panel.connectionError, '')
  assert.equal(panel.profileId, '')
  assert.equal(panel.connected, true)
  assert.equal(panel.currentModel, 'codex-native')
  assert.equal(panel.entries.some(entry => entry.text === 'Original DS request'), true)
  assert.match(seed, /Original DS request/)
  assert.match(seed, /forwarded original terminal/)
  assert.equal(savedGoal.objective, 'Shared task goal')
  const restarted = new CodexService()
  restarted.setContextStore(f.store)
  assert.equal((await restarted.inheritedTurns('codex-seeded'))[0].items[0].content[0].text, 'Original DS request')
  nativeTurns = [{ id: 'codex-turn', status: 'completed', items: [
    { id: 'codex-user', type: 'userMessage', content: [{ type: 'text', text: 'Codex follow-up' }] },
    { id: 'codex-answer', type: 'agentMessage', text: 'Codex answer' },
  ] }]
  savedGoal.tokensUsed = 5
  await panel.selectConnection(f.profile.id)
  assert.equal(panel.connectionError, '')
  assert.equal(panel.profileId, f.profile.id)
  assert.equal(panel.currentModel, f.profile.model)
  assert.deepEqual(panel.entries.filter(entry => entry.kind === 'user').map(entry => entry.text), ['Original DS request', 'Codex follow-up'])
  assert.equal(panel.entries.some(entry => entry.text === 'Codex answer'), true)
  assert.equal((await returned.getGoal(panel.threadId)).usedTokens, 20)
  completed = turnFinished(returned)
  await returned.startTurn(panel.threadId, 'Continue on DS', '/workspace', settings)
  assert.equal((await completed).status, 'completed')
  await panel.newConversation()
  assert.equal(panel.connectionError, '')
  assert.equal(panel.entries.length, 0)
  assert.deepEqual((await f.store.load(panel.threadId)).messages, [])
})

for (const provider of ['openai', 'glm', 'claude']) {
  test(`${provider}: test connection uses the configured protocol without adding tools`, async t => {
    const f = await fixture(t, provider, (req, res, round) => {
      assert.equal(req.body.tools, undefined)
      reply(provider, res, round, null)
    })
    const component = new CodexSettingsComponent({ store: { codexAgent: {} } }, { read: async () => 'fixture-secret' }, zone)
    await component.testProfile(f.profile)
    assert.match(component.connectionTests[f.profile.id].notice, /测试成功/)
    assert.equal(f.requests.length, 1)
  })
}

test('a non-streaming proxy response is reported as a stream compatibility error', async t => {
  const f = await fixture(t, 'deepseek', (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"choices":[{"message":{"content":"whole answer"}}]}')
  })
  const component = new CodexSettingsComponent({ store: { codexAgent: {} } }, { read: async () => 'fixture-secret' }, zone)
  await component.testProfile(f.profile)
  assert.match(component.connectionTests[f.profile.id].notice, /测试失败.*SSE/)
})

test('Codex imports goals without inference and activates them only after an explicit turn is accepted', async t => {
  const f = await fixture(t, 'deepseek', (req, res, round) => reply('deepseek', res, round, null))
  const context = await f.agent.exportContext(f.id)
  context.goal = { objective: 'Imported task', status: 'active', tokenBudget: 100, usedTokens: 20 }
  const codex = new CodexService()
  codex.setContextStore(f.store)
  const calls = []
  let goal
  codex.client.request = async (method, params) => {
    calls.push({ method, params })
    if (method === 'thread/start') return { thread: { id: 'codex-pending' } }
    if (method === 'thread/goal/set') { goal = { ...goal, ...params, tokensUsed: 0 }; return { goal } }
    if (method === 'thread/goal/get') return { goal }
    if (method === 'turn/start') return { turn: { id: 'explicit-turn' } }
    throw new Error(method)
  }
  const nativeSettings = { ...settings, model: '', reasoningEffort: '', tabToolThreads: {} }
  const id = await codex.importContext(context, '/workspace', nativeSettings)
  assert.equal(calls.some(call => call.method === 'turn/start'), false)
  assert.equal(goal.status, 'paused', 'migration must not activate an autonomous native goal')
  assert.equal(goal.tokenBudget, 80)
  assert.equal((await codex.getGoal(id)).status, 'active', 'logical goal remains available to Continue')
  assert.equal((await codex.getGoal(id)).tokensUsed, 20)
  assert.equal(await codex.startTurn(id, 'Continue explicitly', '/workspace', nativeSettings), 'explicit-turn')
  const startIndex = calls.findIndex(call => call.method === 'turn/start')
  const activateIndex = calls.findIndex(call => call.method === 'thread/goal/set' && call.params.status === 'active')
  assert.equal(activateIndex > startIndex, true)
  assert.equal((await f.store.loadCodexContextRecord(id)).goalPending, false)
  assert.equal((await codex.getGoal(id)).tokenBudget, 100)
  await codex.setGoal(id, 'Replacement task', 200)
  assert.equal(goal.status, 'paused', 'a new user goal also waits for the explicit turn')
  assert.equal((await codex.getGoal(id)).status, 'active')
  assert.equal((await codex.getGoal(id)).tokensUsed, 0)
})

test('failure to activate a migrated goal never reports an already accepted native turn as a rejected send', async t => {
  const f = await fixture(t, 'deepseek', (req, res, round) => reply('deepseek', res, round, null))
  const context = await f.agent.exportContext(f.id)
  context.goal = { objective: 'Task', status: 'active', tokenBudget: 0, usedTokens: 0 }
  await f.store.saveCodexContext('native-thread', context, true)
  const codex = new CodexService()
  codex.setContextStore(f.store)
  const notices = []
  let starts = 0
  codex.client.on('event', event => { if (event.method === 'agent/notice') notices.push(event.params.message) })
  codex.client.request = async method => {
    if (method === 'turn/start') { starts++; return { turn: { id: 'accepted' } } }
    if (method === 'thread/goal/set') throw new Error('Goal activation unavailable')
    throw new Error(method)
  }
  assert.equal(await codex.startTurn('native-thread', 'Continue', '/workspace', { ...settings, model: '' }), 'accepted')
  assert.equal(starts, 1)
  assert.match(notices[0], /任务已开始.*恢复任务目标失败/)
  assert.equal((await f.store.loadCodexContextRecord('native-thread')).goalPending, true)
})

test('a migrated Codex session can recover after restart before the first native message is materialized', async t => {
  const f = await fixture(t, 'deepseek', (req, res, round) => reply('deepseek', res, round, null))
  const context = await f.agent.exportContext(f.id)
  context.messages.push({ role: 'user', content: 'Do not lose this task' })
  context.turns.push({ id: 'task-turn', status: 'completed', items: [{ id: 'task', type: 'userMessage', content: [{ type: 'text', text: 'Do not lose this task' }] }] })
  await f.store.saveCodexContext('old-unmaterialized', context)
  const restarted = new CodexService()
  restarted.setContextStore(f.store)
  restarted.client.request = async (method, params) => {
    if (method === 'thread/resume') throw new Error('thread not found: no rollout')
    if (method === 'thread/start') {
      assert.match(params.developerInstructions, /Do not lose this task/)
      return { thread: { id: 'recovered-thread' } }
    }
    throw new Error(method)
  }
  assert.equal(await restarted.resumeThread('old-unmaterialized', '/workspace', { ...settings, model: '', tabToolThreads: {} }), 'recovered-thread')
  assert.deepEqual(await restarted.inheritedTurns('recovered-thread'), context.turns)
})

test('settings switch the editor without changing the default or discarding edits and key drafts', () => {
  const first = { id: 'first', name: 'OpenAI', provider: 'openai', model: 'model-a' }
  const second = { id: 'second', name: 'DeepSeek', provider: 'deepseek', model: 'model-b' }
  const settings = { apiProfiles: [first, second], defaultProfileId: 'second' }
  let saves = 0
  const component = new CodexSettingsComponent({ store: { codexAgent: settings }, save: async () => { saves++ } }, {}, zone)
  assert.equal(component.selectedProfile, second)
  component.keyDrafts.second = 'unsaved-vault-key'
  second.name = 'Edited name'
  component.advancedOpen = true
  component.selectProfile(first.id)
  assert.equal(component.selectedProfile, first)
  assert.equal(component.advancedOpen, false)
  assert.equal(settings.defaultProfileId, 'second')
  component.selectProfile('')
  assert.equal(component.selectedProfile, undefined)
  component.selectProfile(second.id)
  assert.equal(component.selectedProfile.name, 'Edited name')
  assert.equal(component.keyDrafts.second, 'unsaved-vault-key')
  assert.equal(saves, 0, 'editor navigation must not save or change configuration')
  component.setDefault(first.id)
  assert.equal(settings.defaultProfileId, first.id)
  assert.equal(component.selectedProfile, second, 'setting the default must not switch the editor')
  assert.equal(saves, 1)
})

test('settings select new connections and keep a valid editor when removing selected connections', () => {
  const first = { id: 'first', name: 'First', provider: 'openai' }
  const second = { id: 'second', name: 'Second', provider: 'claude' }
  const settings = { apiProfiles: [first, second], defaultProfileId: 'second' }
  const component = new CodexSettingsComponent({ store: { codexAgent: settings }, save: async () => {} }, {}, zone)
  const controller = new AbortController()
  component.testing.set(second.id, controller)
  component.keyDrafts.second = 'draft'
  component.removeProfile(second)
  assert.equal(controller.signal.aborted, true)
  assert.equal(settings.defaultProfileId, '')
  assert.equal(component.selectedProfile, first)
  assert.equal(component.keyDrafts.second, undefined)
  component.addProfile()
  const added = component.selectedProfile
  assert.ok(added.id)
  assert.notEqual(added.id, first.id)
  assert.equal(settings.apiProfiles.length, 2)
  assert.equal(settings.defaultProfileId, '', 'adding a connection must preserve the default')
  component.removeProfile(first)
  assert.equal(component.selectedProfile, added, 'deleting a different connection must preserve selection')
  component.removeProfile(added)
  assert.deepEqual(settings.apiProfiles, [])
  assert.equal(component.selectedProfileId, '')
  assert.equal(component.selectedProfile, undefined)
  component.ngOnDestroy()
})

test('settings handle an empty list and select a neighboring connection after deletion', () => {
  const config = { store: { codexAgent: {} }, save: async () => {} }
  const empty = new CodexSettingsComponent(config, {}, zone)
  assert.equal(empty.selectedProfile, undefined)
  empty.addProfile()
  assert.equal(empty.profiles.length, 1)
  assert.equal(empty.selectedProfile, empty.profiles[0])
  const profiles = ['a', 'b', 'c'].map(id => ({ id, name: id, provider: 'openai' }))
  const settings = { apiProfiles: profiles, defaultProfileId: 'missing' }
  const component = new CodexSettingsComponent({ store: { codexAgent: settings }, save: async () => {} }, {}, zone)
  assert.equal(component.selectedProfile, profiles[0], 'stale default falls back to the first connection')
  component.selectProfile('b')
  component.removeProfile(profiles[1])
  assert.equal(component.selectedProfile.id, 'c')
})
