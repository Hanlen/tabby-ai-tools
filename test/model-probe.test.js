const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { EventEmitter } = require('node:events')
const ts = require('typescript')
const original = require.extensions['.ts']
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText, filename)
const { probeCodexModel, probeApiModel, runModelProbe } = require('../src/model-probe.ts')
const { ApiProviderAdapter } = require('../src/api-provider.ts')
require.extensions['.ts'] = original
const settings = { executable: 'codex-fixture', model: 'gpt-6-sol', reasoningEffort: 'high', cwd: '/must-not-read-user-workspace' }

function clientFixture (invalid = false) {
  const client = new EventEmitter(), calls = []
  let nonce
  client.connect = async executable => calls.push({ method: 'connect', executable })
  client.request = async (method, params) => {
    calls.push({ method, params })
    if (method === 'thread/start') {
      assert.equal(typeof params.dynamicTools[0].description, 'string')
      assert.ok(params.dynamicTools[0].description.length)
      nonce = params.dynamicTools[0].tools[0].inputSchema.properties.nonce.enum[0]
      return { thread: { id: 'probe-thread' } }
    }
    if (method === 'turn/start') {
      setImmediate(() => client.emit('event', { id: 9, method: 'item/tool/call', params: { threadId: 'probe-thread', namespace: 'tabby_model_test', tool: invalid ? 'run_shell' : 'confirm', arguments: { nonce } } }))
      return { turn: { id: 'probe-turn' } }
    }
    throw new Error('unexpected request')
  }
  client.respond = (_id, response) => {
    assert.equal(response.success, true)
    client.emit('event', { method: 'thread/tokenUsage/updated', params: { threadId: 'probe-thread', tokenUsage: { total: { totalTokens: 12 } } } })
    client.emit('event', { method: 'turn/completed', params: { threadId: 'probe-thread', turn: { status: 'completed' } } })
  }
  client.respondError = (_id, error) => calls.push({ method: 'respondError', error })
  client.close = () => calls.push({ method: 'close' })
  return { client, calls }
}

test('Codex readiness uses exactly gpt-6-sol/high in an isolated ephemeral session', async () => {
  const f = clientFixture()
  const tokens = await probeCodexModel(settings, new AbortController().signal, f.client)
  assert.equal(tokens, 12)
  const thread = f.calls.find(call => call.method === 'thread/start').params
  const turn = f.calls.find(call => call.method === 'turn/start').params
  assert.equal(thread.model, 'gpt-6-sol')
  assert.equal(thread.config.model_reasoning_effort, 'high')
  assert.equal(thread.config['features.shell_tool'], false)
  assert.equal(thread.config['features.apps'], false)
  assert.equal(thread.config.web_search, 'disabled')
  assert.equal(thread.ephemeral, true)
  assert.equal(thread.sandbox, 'read-only')
  assert.notEqual(thread.cwd, settings.cwd)
  assert.equal(turn.model, 'gpt-6-sol')
  assert.equal(turn.effort, 'high')
  assert.equal(turn.cwd, thread.cwd)
  assert.equal(fs.existsSync(thread.cwd), false)
  assert.equal(f.calls.at(-1).method, 'close')
  assert.equal(f.client.listenerCount('event'), 0)
})

test('Codex readiness rejects an unexpected tool and cleans up without running it', async () => {
  const f = clientFixture(true)
  await assert.rejects(probeCodexModel(settings, new AbortController().signal, f.client), /范围以外/)
  assert.ok(f.calls.some(call => call.method === 'respondError'))
  assert.equal(f.calls.at(-1).method, 'close')
})

test('probe deadline reports failure and aborts the underlying request', async () => {
  let aborted = false
  const result = await runModelProbe(settings, signal => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new Error('timeout')) }, { once: true })
  }), undefined, 10)
  assert.equal(result.ok, false)
  assert.equal(aborted, true)
  assert.match(result.error, /超过/)
})

test('explicit cancellation rejects instead of treating it as a fallback-worthy model failure', async () => {
  const controller = new AbortController()
  const result = runModelProbe(settings, () => new Promise(() => {}), controller.signal)
  controller.abort()
  await assert.rejects(result, /取消/)
})

test('probe failures redact credentials and successful probes preserve requested settings', async () => {
  const failed = await runModelProbe(settings, async () => { throw new Error('token=secret-value') })
  assert.equal(failed.ok, false)
  assert.doesNotMatch(failed.error, /secret-value/)
  const passed = await runModelProbe(settings, async () => 14)
  assert.equal(passed.ok, true)
  assert.equal(passed.model, 'gpt-6-sol')
  assert.equal(passed.reasoningEffort, 'high')
  assert.equal(passed.totalTokens, 14)
})

for (const variant of ['missing', 'wrong-name', 'wrong-nonce', 'invalid-json', 'duplicate', 'stream-error']) {
  test(`API probe retains 600 reported tokens on ${variant}`, async t => {
    const generate = ApiProviderAdapter.prototype.generate
    t.after(() => { ApiProviderAdapter.prototype.generate = generate })
    ApiProviderAdapter.prototype.generate = async (_messages, _system, tools, _signal, _text, _progress, onUsage) => {
      onUsage(600)
      if (variant === 'stream-error') throw new Error('stream disconnected')
      const call = { name: 'confirm', arguments: JSON.stringify({ nonce: tools[0].inputSchema.properties.nonce.enum[0] }) }
      if (variant === 'wrong-name') call.name = 'other'
      if (variant === 'wrong-nonce') call.arguments = '{"nonce":"wrong"}'
      if (variant === 'invalid-json') call.arguments = '{'
      return { totalTokens: 600, tools: variant === 'missing' ? [] : variant === 'duplicate' ? [call, call] : [call] }
    }
    const result = await runModelProbe(settings, (signal, usage) => probeApiModel({ maxOutputTokens: 4096 }, async () => 'fixture', signal, usage))
    assert.equal(result.ok, false)
    assert.equal(result.totalTokens, 600)
  })
}

test('Codex probe retains known usage when tool validation fails', async () => {
  const f = clientFixture(true)
  const request = f.client.request
  f.client.request = async (method, params) => {
    const result = await request(method, params)
    if (method === 'turn/start') f.client.emit('event', { method: 'thread/tokenUsage/updated', params: { threadId: 'probe-thread', tokenUsage: { total: { totalTokens: 600 } } } })
    return result
  }
  const result = await runModelProbe(settings, (signal, usage) => probeCodexModel(settings, signal, f.client, usage))
  assert.equal(result.ok, false)
  assert.equal(result.totalTokens, 600)
})

test('deadline and cancellation preserve already reported usage despite the abort race', async () => {
  const result = await runModelProbe(settings, (_signal, usage) => { usage(600); return new Promise(() => {}) }, undefined, 10)
  assert.equal(result.ok, false)
  assert.equal(result.totalTokens, 600)
  const controller = new AbortController()
  const cancelled = runModelProbe(settings, (_signal, usage) => { usage(601); return new Promise(() => {}) }, controller.signal)
  controller.abort()
  await assert.rejects(cancelled, error => error.totalTokens === 601 && /取消/.test(error.message))
})

for (const [provider, variant] of [['openai', 'incomplete'], ['openai', 'failed'], ['openai', 'invalid-output'], ['deepseek', 'missing-finish'], ['deepseek', 'invalid-tool'], ['glm', 'missing-finish'], ['glm', 'invalid-tool'], ['kimi', 'missing-finish'], ['kimi', 'invalid-tool'], ['kimi-coding', 'missing-finish'], ['kimi-coding', 'invalid-tool'], ['bailian-coding', 'missing-finish'], ['bailian-coding', 'invalid-tool'], ['claude', 'incomplete']]) {
  test(`${provider}: real HTTP/SSE ${variant} retains usage before protocol failure`, async t => {
    const http = require('node:http')
    const event = provider === 'openai' ? { type: variant === 'invalid-output' ? 'response.completed' : `response.${variant}`, response: { usage: { input_tokens: 600, output_tokens: 0, total_tokens: 600 } } }
      : provider === 'claude' ? { type: 'message_start', message: { usage: { input_tokens: 600 } } }
        : { choices: variant === 'invalid-tool' ? [{ delta: { tool_calls: {} } }] : [], usage: { prompt_tokens: 600, completion_tokens: 0, total_tokens: 600 } }
    const server = http.createServer((request, response) => {
      request.resume()
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: ' + JSON.stringify(event) + '\n\n')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve) }))
    const profile = { provider, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture-model', maxOutputTokens: 4096, thinking: 'default' }
    const result = await runModelProbe(settings, (signal, usage) => probeApiModel(profile, async () => 'fixture', signal, usage))
    assert.equal(result.ok, false)
    assert.equal(result.totalTokens, 600)
  })
}
