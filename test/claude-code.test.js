const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const Module = require('node:module')
const ts = require('typescript')
const originalLoad = Module._load
const originalTs = require.extensions['.ts']
Module._load = function (request, parent, main) {
  if (request === '@angular/core') return { Injectable: () => target => target, Component: () => target => target, Input: () => () => {}, Output: () => () => {}, ViewChild: () => () => {}, EventEmitter: require('node:events').EventEmitter }
  if (request === 'tabby-core' || request === 'tabby-terminal') return {}
  if (request === 'tabby-settings') return { SettingsTabProvider: class {} }
  if (request.endsWith('.pug') || request.endsWith('.css')) return ''
  return originalLoad.call(this, request, parent, main)
}
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, experimentalDecorators: true } }).outputText, filename)
const { ClaudeCodeAgent, ClaudeCodeAdapter, claudeCodeProfile } = require('../src/claude-code-agent.ts')
const { resolveClaudeExecutable, inspectClaudeCode, runClaudeProcess } = require('../src/claude-code-client.ts')
const { createClaudeMcp } = require('../src/claude-code-mcp.ts')
const { AgentStore } = require('../src/agent-store.ts')
const { AgentBackendFactory } = require('../src/agent-backend.service.ts')
const { CodexPanelComponent } = require('../src/codex-panel.component.ts')
const { CodexSettingsComponent } = require('../src/settings.ts')
const { ScheduledTaskStore } = require('../src/scheduled-tasks.ts')
const { ScheduledWorkflowRunner } = require('../src/scheduled-workflow-runner.ts')
Module._load = originalLoad
require.extensions['.ts'] = originalTs

const done = agent => new Promise(resolve => {
  const listener = event => { if (event.method === 'turn/completed') { agent.off('event', listener); resolve(event.params.turn) } }
  agent.on('event', listener)
})
const settingsBase = { executable: 'codex', cwd: '', model: '', reasoningEffort: '', sandbox: 'workspace-write', approvalPolicy: 'never', goalTokenBudget: 0, threads: {}, tabToolThreads: {} }
async function fixture (t, scenario = {}) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tabby claude test '))
  await fs.promises.copyFile(path.join(__dirname, 'fixtures/claude-cli.cjs'), path.join(root, 'cli.cjs'))
  const executable = path.join(root, process.platform === 'win32' ? 'claude.cmd' : 'claude')
  const contents = process.platform === 'win32' ? `@"${process.execPath}" "${path.join(root, 'cli.cjs')}" %*\r\n` : `#!${process.execPath}\nrequire('./cli.cjs')\n`
  await fs.promises.writeFile(executable, contents, { mode: 0o700 })
  await fs.promises.writeFile(path.join(root, 'scenario.json'), JSON.stringify(scenario))
  const settings = { ...settingsBase, cwd: root, claudeExecutable: executable, claudeModel: 'sonnet', claudeThreads: {} }
  const profile = claudeCodeProfile(settings)
  const store = new AgentStore(path.join(root, 'store'))
  const agent = new ClaudeCodeAgent(profile, store, executable)
  const capture = () => JSON.parse(fs.readFileSync(path.join(root, 'capture.json'), 'utf8'))
  t.after(async () => { agent.close(); await Promise.all([...agent.running.values()].map(job => job.done)); await fs.promises.rm(root, { recursive: true, force: true }) })
  return { root, executable, settings, profile, agent, store, capture }
}
const waitFor = async predicate => {
  for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)) }
  throw new Error('Timed out waiting for fixture')
}

function answerTools (agent, callback) {
  agent.on('event', event => {
    if (event.id !== undefined && event.method === 'item/tool/call') {
      callback?.(event)
      agent.respond(event.id, { success: true, contentItems: [{ type: 'inputText', text: 'observed fixture output' }] })
    }
  })
}

test('native Claude streams through authenticated loopback MCP and records tool intent before execution', async t => {
  const f = await fixture(t, { tools: [{ name: 'list_tabs' }, { name: 'read_tab', arguments: { tabId: 'term1' } }] })
  await f.agent.connect(f.settings)
  const id = await f.agent.openThread(f.root, f.settings)
  const deltas = []
  f.agent.on('event', event => { if (event.method === 'item/agentMessage/delta') deltas.push(event.params.delta) })
  let recordedBefore = false
  f.agent.on('event', event => {
    if (event.id !== undefined && event.method === 'item/tool/call') {
      const persisted = JSON.parse(fs.readFileSync(path.join(f.root, 'store', id + '.json'), 'utf8'))
      recordedBefore = persisted.turns.at(-1).items.some(item => item.command?.startsWith(event.params.tool))
      f.agent.respond(event.id, { success: true, contentItems: [{ type: 'inputText', text: 'actual observation' }] })
    }
  })
  const finished = done(f.agent)
  await f.agent.startTurn(id, 'Inspect the terminals', f.root, f.settings)
  assert.equal((await finished).status, 'completed')
  assert.ok(recordedBefore)
  assert.equal(deltas.join(''), 'Verified result')
  const saved = await f.store.load(id)
  assert.equal(saved.totalTokens, 17, 'duplicate assistant usage is counted once')
  assert.equal(saved.claudeSession.messageCount, saved.messages.length)
  assert.equal(saved.turns[0].items.filter(item => item.type === 'commandExecution').length, 2)
  const capture = f.capture()
  assert.equal(capture.args[capture.args.indexOf('--tools') + 1], '')
  assert.ok(capture.args.includes('--strict-mcp-config'))
  assert.ok(capture.args.includes('--disable-slash-commands'))
  assert.ok(capture.args.includes('--append-system-prompt-file'))
  assert.ok(capture.system.includes('agent_goal_update'))
  await assert.rejects(fs.promises.stat(capture.args[capture.args.indexOf('--mcp-config') + 1]), { code: 'ENOENT' })
  await assert.rejects(fetch(capture.config.url), /fetch failed/)
})

test('Claude native history resumes after restart, sends only new input and migrates portable context', async t => {
  const f = await fixture(t)
  await f.agent.connect(f.settings)
  const id = await f.agent.openThread(f.root, f.settings)
  let finished = done(f.agent)
  await f.agent.startTurn(id, 'first request', f.root, f.settings)
  await finished
  const first = await f.store.load(id)
  f.agent.close()
  const resumed = new ClaudeCodeAgent(f.profile, f.store, f.executable)
  t.after(() => resumed.close())
  await resumed.connect(f.settings)
  assert.equal(await resumed.openThread(f.root, f.settings, id), id)
  finished = done(resumed)
  await resumed.startTurn(id, 'second request', f.root, f.settings)
  assert.equal((await finished).status, 'completed')
  const capture = f.capture()
  assert.equal(capture.args[capture.args.indexOf('--resume') + 1], first.claudeSession.id)
  assert.doesNotMatch(capture.input, /first request/)
  assert.match(capture.input, /second request/)
  assert.equal((await f.store.load(id)).totalTokens, 34)
  const exported = await resumed.exportContext(id)
  assert.ok(exported.messages.some(message => message.content.includes('first request')))
  const other = new ClaudeCodeAgent({ ...f.profile, model: 'opus' }, f.store, f.executable)
  t.after(() => other.close())
  const importedId = await other.importContext(exported, f.root, f.settings)
  assert.notEqual(importedId, id)
  assert.equal((await f.store.load(importedId)).claudeSession, undefined)
  assert.ok((await f.store.load(importedId)).messages.some(message => message.content.includes('second request')))
})

for (const policy of ['read-only', 'decline', 'accept']) {
  test(`Claude tool permissions: ${policy}`, async t => {
    const f = await fixture(t, { tools: [{ name: 'send_input', arguments: { tabId: 'term1', text: 'echo test', submit: true } }] })
    const settings = { ...f.settings, sandbox: policy === 'read-only' ? 'read-only' : 'workspace-write', approvalPolicy: 'on-request' }
    await f.agent.connect(settings)
    const id = await f.agent.openThread(f.root, settings)
    let approvals = 0, mutations = 0
    answerTools(f.agent, () => mutations++)
    f.agent.on('event', event => {
      if (event.method === 'item/commandExecution/requestApproval') { approvals++; f.agent.respond(event.id, { decision: policy }) }
    })
    const finished = done(f.agent)
    await f.agent.startTurn(id, 'Use the terminal', f.root, settings)
    await finished
    assert.equal(approvals, policy === 'read-only' ? 0 : 1)
    assert.equal(mutations, policy === 'accept' ? 1 : 0)
    if (policy === 'read-only') assert.ok(f.capture().calls.find(call => call.method === 'tools/call').response.error)
  })
}

for (const mode of ['hang', 'badJson', 'noResult', 'resultError', 'wrongSession']) {
  test(`Claude ${mode} stops cleanly and never retries inference`, async t => {
    const f = await fixture(t, { [mode]: true })
    await f.agent.connect(f.settings)
    const id = await f.agent.openThread(f.root, f.settings)
    const finished = done(f.agent)
    const turnId = await f.agent.startTurn(id, 'Work', f.root, f.settings)
    if (mode === 'hang') {
      await waitFor(() => fs.existsSync(path.join(f.root, 'capture.json')))
      await f.agent.interrupt(id, turnId)
    }
    const turn = await finished
    assert.equal(turn.status, mode === 'hang' ? 'interrupted' : 'failed')
    const saved = await f.store.load(id)
    assert.equal(saved.claudeSession, undefined)
    assert.match(saved.messages.at(-1).content, /不要自动重复/)
    assert.throws(() => process.kill(f.capture().pid, 0), /ESRCH/)
  })
}

test('Claude token budget stops native tools before a terminal operation and keeps observed usage', async t => {
  const f = await fixture(t, { tools: [{ name: 'list_tabs' }] })
  await f.agent.connect(f.settings)
  const id = await f.agent.openThread(f.root, f.settings)
  await f.agent.setGoal(id, 'Inspect', 10)
  let calls = 0
  answerTools(f.agent, () => calls++)
  const finished = done(f.agent)
  await f.agent.startTurn(id, 'Inspect', f.root, f.settings)
  assert.equal((await finished).status, 'failed')
  const saved = await f.store.load(id)
  assert.equal(saved.goal.status, 'budgetLimited')
  assert.equal(saved.goal.usedTokens, 17)
  assert.equal(saved.totalTokens, 17)
  assert.equal(calls, 0)
})

test('native Claude resumes an active goal after a normal response in the same turn', async t => {
  const f = await fixture(t, { invocations: [
    { tools: [{ name: 'read_tab', arguments: { tabId: 'one' } }] },
    { tools: [
      { name: 'read_tab', arguments: { tabId: 'one' } },
      { name: 'agent_goal_update', arguments: { status: 'complete', evidence: 'Verified fresh terminal output' } },
    ] },
  ] })
  await f.agent.connect(f.settings)
  const id = await f.agent.openThread(f.root, f.settings)
  await f.agent.setGoal(id, 'Finish the terminal task', 0)
  let calls = 0, starts = 0
  answerTools(f.agent, () => calls++)
  f.agent.on('event', event => { if (event.method === 'turn/started') starts++ })
  const finished = done(f.agent)
  await f.agent.startTurn(id, 'Inspect', f.root, f.settings)
  assert.equal((await finished).status, 'completed')
  assert.equal(starts, 1)
  assert.equal(calls, 2)
  const capture = f.capture()
  assert.ok(capture.args.includes('--resume'))
  assert.match(capture.input, /current goal is still active/)
  const saved = await f.store.load(id)
  assert.equal(saved.goal.status, 'complete')
  assert.equal(saved.totalTokens, 34)
  assert.equal(saved.turns.length, 1)
})

test('MCP rejects unauthenticated, cross-origin, unknown and invalid requests, and serializes calls', async t => {
  const controller = new AbortController()
  let active = 0, maxActive = 0, called = 0
  const bridge = await createClaudeMcp([{ name: 'observe', inputSchema: { type: 'object' }, description: 'Observe' }], async call => {
    called++; maxActive = Math.max(maxActive, ++active)
    await new Promise(resolve => setTimeout(resolve, 10))
    active--
    return { id: call.id, result: 'ok' }
  }, controller.signal)
  t.after(() => bridge.close())
  const config = bridge.config.mcpServers.tabby
  const post = (body, headers = config.headers) => fetch(config.url, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })
  assert.equal((await post({}, {})).status, 403)
  assert.equal((await post({}, { ...config.headers, Origin: 'https://example.com' })).status, 403)
  assert.equal((await post('bad-json')).status, 400)
  const unknown = await (await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_input' } })).json()
  assert.equal(unknown.error.code, -32602)
  const call = id => post({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'observe' } })
  await Promise.all([call(1), call(2), call(3)])
  assert.equal(called, 3)
  assert.equal(maxActive, 1)
  controller.abort()
  assert.ok((await (await call(4)).json()).error)
  assert.equal(called, 3)
})

test('CLI discovery handles explicit paths with spaces and rejects missing login or capability without inference', async t => {
  const f = await fixture(t, { missingFlag: '--tools' })
  assert.equal(resolveClaudeExecutable('"' + f.executable + '"'), f.executable)
  await assert.rejects(inspectClaudeCode(f.executable, f.root, new AbortController().signal), /更新官方 CLI/)
  assert.equal(fs.existsSync(path.join(f.root, 'capture.json')), false)
  await fs.promises.writeFile(path.join(f.root, 'scenario.json'), JSON.stringify({ loggedIn: false }))
  await assert.rejects(inspectClaudeCode(f.executable, f.root, new AbortController().signal), /claude auth login/)
  assert.throws(() => resolveClaudeExecutable(path.join(f.root, 'missing')), /找不到 Claude Code/)
})

test('factory and settings expose a native Claude connection independently of API keys and model settings', async t => {
  const f = await fixture(t)
  const config = { store: { codexAgent: { ...f.settings, model: 'codex-model', apiProfiles: [], defaultProfileId: 'claude-code' } }, save: async () => {} }
  const factory = new AgentBackendFactory(config, {}, { read: () => { throw new Error('must never read an API key') } }, { getConfigPath: () => path.join(f.root, 'tabby.yaml') })
  const native = factory.create('claude-code')
  assert.ok(native instanceof ClaudeCodeAgent)
  const component = new CodexSettingsComponent(config, {}, { run: fn => fn() })
  assert.equal(component.claudeCodeSelected, true)
  assert.equal(component.selectedProfile, undefined)
  const panel = Object.create(CodexPanelComponent.prototype)
  panel.config = config; panel.codex = native; panel.profileId = 'claude-code'
  panel.settings.model = 'opus'
  assert.equal(config.store.codexAgent.claudeModel, 'opus')
  assert.equal(config.store.codexAgent.model, 'codex-model')
  panel.settings.threads[f.root] = 'native-session'
  assert.equal(config.store.codexAgent.claudeThreads[f.root], 'native-session')
  assert.ok(factory.modelConnections().some(item => item.profileId === 'claude-code'))
})

test('native Claude model picker selects reasoning before applying and passes it to the CLI', async t => {
  const f = await fixture(t)
  await f.agent.connect(f.settings)
  const id = await f.agent.openThread(f.root, f.settings)
  const config = { store: { codexAgent: f.settings }, save: async () => {} }
  let first = true, selected
  const factory = { defaultProfileId: 'claude-code', create: () => {
    if (first) { first = false; return f.agent }
    selected = new ClaudeCodeAgent(claudeCodeProfile(f.settings), f.store, f.executable)
    return selected
  } }
  const panel = new CodexPanelComponent(config, f.agent, { run: fn => fn() }, {}, { releaseOwner: () => {} }, factory)
  panel.cwd = f.root; panel.threadId = id; panel.loading = false; panel.connected = true
  t.after(() => panel.ngOnDestroy())
  await panel.openModelPicker()
  await panel.selectModel('opus')
  assert.equal(panel.pendingModel.model, 'opus')
  assert.deepEqual(panel.pendingModel.supportedReasoningEfforts.map(option => option.reasoningEffort), ['low', 'medium', 'high'])
  assert.equal(f.settings.claudeModel, 'sonnet')
  await panel.chooseModel('opus', 'high')
  assert.equal(panel.connectionError, '')
  assert.equal(f.settings.claudeModel, 'opus')
  assert.equal(f.settings.claudeReasoningEffort, 'high')
  assert.equal(f.settings.reasoningEffort, '', 'Codex settings remain independent')
  const finished = done(selected)
  await selected.startTurn(panel.threadId, 'Inspect', f.root, f.settings)
  assert.equal((await finished).status, 'completed')
  const args = f.capture().args
  assert.equal(args[args.indexOf('--model') + 1], 'opus')
  assert.equal(args[args.indexOf('--effort') + 1], 'high')
})

test('scheduled model probe tests native MCP confirmation without touching terminals', async t => {
  const f = await fixture(t, { probe: true })
  const factory = new AgentBackendFactory({ store: { codexAgent: f.settings } }, {}, {}, {})
  const result = await factory.probeModel('claude-code', { ...f.settings, model: 'sonnet' })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.totalTokens, 17)
  assert.deepEqual(f.capture().calls.filter(call => call.method === 'tools/call').map(call => call.params.name), ['confirm'])
})


test('stopping Claude while host approval is pending cancels the approval and executes no mutation', async t => {
  const f = await fixture(t, { tools: [{ name: 'send_input', arguments: { tabId: 'term1', text: 'echo pending', submit: true } }] })
  const settings = { ...f.settings, approvalPolicy: 'on-request' }
  await f.agent.connect(settings)
  const id = await f.agent.openThread(f.root, settings)
  let mutations = 0, requestId
  answerTools(f.agent, () => mutations++)
  f.agent.on('event', event => { if (event.method === 'item/commandExecution/requestApproval') requestId = event.id })
  const finished = done(f.agent)
  const turnId = await f.agent.startTurn(id, 'Inspect', f.root, settings)
  await waitFor(() => requestId !== undefined)
  await f.agent.interrupt(id, turnId)
  f.agent.respond(requestId, { decision: 'accept' })
  assert.equal((await finished).status, 'interrupted')
  assert.equal(mutations, 0)
  assert.equal(f.agent.pending.size, 0)
})

test('messages queued during a native invocation are preserved and sent once in a following invocation', async t => {
  const f = await fixture(t, { tools: [{ name: 'list_tabs' }] })
  await f.agent.connect(f.settings)
  const id = await f.agent.openThread(f.root, f.settings)
  let steered = false, turnId
  f.agent.on('event', event => {
    if (event.method === 'item/tool/call') {
      if (!steered) { steered = true; void f.agent.steer(id, turnId, 'also check staging') }
      f.agent.respond(event.id, { success: true, contentItems: [{ type: 'inputText', text: 'observed' }] })
    }
  })
  const finished = done(f.agent)
  turnId = await f.agent.startTurn(id, 'initial task', f.root, f.settings)
  assert.equal((await finished).status, 'completed')
  const capture = f.capture()
  assert.ok(capture.args.includes('--resume'))
  assert.match(capture.input, /also check staging/)
  assert.doesNotMatch(capture.input, /initial task/)
  assert.equal((await f.store.load(id)).messages.filter(message => message.content === 'also check staging').length, 1)
})

test('crash recovery invalidates the native continuation and retains observed operations without replay', async t => {
  const f = await fixture(t)
  await f.agent.connect(f.settings)
  const id = await f.agent.openThread(f.root, f.settings)
  const saved = await f.store.load(id)
  saved.claudeSession = { id: '550e8400-e29b-41d4-a716-446655440000', messageCount: 0 }
  saved.turns.push({ id: 'crashed-turn', status: 'inProgress', items: [{ id: 'observed-operation', type: 'commandExecution', command: 'send_input confirmed-task', aggregatedOutput: 'operation already happened' }] })
  await f.store.save(saved)
  await f.agent.resumeThread(id, f.root, f.settings)
  const recovered = await f.store.load(id)
  assert.equal(recovered.claudeSession, undefined)
  assert.equal(recovered.turns[0].status, 'interrupted')
  assert.match(recovered.messages.at(-1).content, /operation already happened/)
  assert.match(recovered.messages.at(-1).content, /禁止自动重放/)
  assert.equal(fs.existsSync(path.join(f.root, 'capture.json')), false)
})

test('native MCP repetition detection stops subsequent operations and leaves the goal unfinished', async t => {
  const f = await fixture(t, { tools: Array.from({ length: 10 }, () => ({ name: 'list_tabs' })) })
  await f.agent.connect(f.settings)
  const id = await f.agent.openThread(f.root, f.settings)
  await f.agent.setGoal(id, 'Inspect the service', 0)
  let calls = 0
  answerTools(f.agent, () => calls++)
  const finished = done(f.agent)
  await f.agent.startTurn(id, 'Inspect', f.root, f.settings)
  const result = await finished
  assert.equal(result.status, 'failed')
  assert.ok(calls < 10)
  assert.equal((await f.store.load(id)).goal.status, 'blocked')
})

test('native Claude executes a scheduled workflow through the existing unattended runner', async t => {
  const f = await fixture(t, { tools: [
    { name: 'list_tabs' },
    { name: 'scheduled_task_finish', arguments: { status: 'completed', evidence: 'Verified the fixture terminal observation' } },
  ] })
  const store = new ScheduledTaskStore(path.join(f.root, 'schedules'))
  const task = await store.create({ title: 'Inspect terminals', instructions: 'Inspect and verify terminal output.', scheduleType: 'interval', intervalMinutes: 5 }, f.root, 'claude-code', { ...f.settings, model: 'sonnet' })
  const { run } = await store.claim('native-fixture', Date.now(), task.id, f.root)
  let calls = 0, released = false
  await new ScheduledWorkflowRunner(store, task, run, f.agent, {
    call: async name => { assert.equal(name, 'list_tabs'); calls++; return { text: 'fixture observation' } },
    release: () => { released = true }, approval: request => assert.equal(request, undefined),
  }).execute()
  const result = (await store.read()).runs[0]
  assert.equal(result.status, 'completed', result.summary)
  assert.equal(result.totalTokens, 17)
  assert.equal(calls, 1)
  assert.equal(released, true)
})


test('unexpected CLI exit cancels outstanding host approvals instead of leaving the turn pending', async t => {
  const f = await fixture(t, { exitDuringTool: true, tools: [{ name: 'send_input', arguments: { tabId: 'term1', text: 'echo pending', submit: true } }] })
  const settings = { ...f.settings, approvalPolicy: 'on-request' }
  await f.agent.connect(settings)
  const id = await f.agent.openThread(f.root, settings)
  let requested = false, mutations = 0
  f.agent.on('event', event => { if (event.method === 'item/commandExecution/requestApproval') requested = true })
  answerTools(f.agent, () => mutations++)
  const finished = done(f.agent)
  await f.agent.startTurn(id, 'Run', f.root, settings)
  const turn = await finished
  assert.equal(turn.status, 'failed')
  assert.equal(requested, true)
  assert.equal(mutations, 0)
  assert.equal(f.agent.pending.size, 0)
})
