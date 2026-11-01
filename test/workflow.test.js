const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const ts = require('typescript')
const previous = require.extensions['.ts']
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
}).outputText, filename)
const { TaskMemory, TaskMemoryStore, observationFingerprint } = require('../src/task-memory.ts')
const { WorkflowRunner } = require('../src/workflow-runner.ts')
const { decideWorkflowInteraction } = require('../src/workflow-decision.ts')
const { runWorkflowTool } = require('../src/workflow-session.ts')
const { validPolicy, matchesConditions } = require('../src/workflow-policy.ts')
require.extensions['.ts'] = previous

const server = { type: 'local', profileId: 'local', serverId: 'local-machine', host: 'test', ip: '127.0.0.1', port: 0, username: 'test', cwd: '/project' }
const condition = (value, source = 'prompt', op = 'contains') => ({ source, op, value })
const node = (extra = {}) => ({ id: 'configure', intent: '保留当前配置，然后继续验证结果', mode: 'model', rules: [], observed: true, ...extra })
const step = (extra = {}) => ({ id: 'step-1', command: 'configure-app', purpose: '配置应用', target: 'test', server, verification: { criteria: 'service healthy', evidence: 'historical evidence', confirmedAt: 1 }, ...extra })
const screen = (text, running = false) => ({ server, text, commandState: running ? 'running' : 'prompt', runningProcesses: running ? ['configure-app'] : [], controlledByAI: running })
async function fixture (t, steps) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tabby-conditional-workflow-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const memory = new TaskMemory(new TaskMemoryStore(root))
  if (steps) memory.beginExecution('owner', { objective: '配置并验证应用', cwd: '/project', steps })
  else await memory.prepare('owner', '配置并验证应用', '/project', true)
  return { root, memory, token: memory.token('owner'), runner: new WorkflowRunner(memory) }
}
function ports (memory, token, observations, decision) {
  const calls = [], decisions = []
  let current = observations.shift()
  return { calls, decisions, signal: new AbortController().signal,
    call: async (name, args) => {
      memory.beforeTool('owner', token, name, args, true)
      calls.push({ name, args })
      if (name === 'read_tab') {
        if (observations.length) current = observations.shift()
        memory.record('owner', token, name, args, current)
        return current
      }
      const result = { sent: true, submitted: true }
      memory.record('owner', token, name, args, result)
      return result
    },
    decide: async input => { decisions.push(input); return decision ? decision(input) : { nodeId: input.node.id, observationId: input.observationId, action: 'respond', response: { kind: 'answer', text: 'keep' }, reason: '按目标保留配置' } },
  }
}

test('stdin and keys archive intent/fallback without raw answers, keys or terminal output', async t => {
  const f = await fixture(t)
  const p = ports(f.memory, f.token, [screen('initial'), screen('initial'), screen('Keep current configuration?', true), screen('Choose option?', true), screen('finished')])
  await p.call('read_tab', { tabId: 'ephemeral' })
  await p.call('send_input', { tabId: 'ephemeral', text: 'configure-app', submit: true })
  await p.call('read_tab', { tabId: 'ephemeral' })
  await p.call('send_input', { tabId: 'ephemeral', mode: 'stdin', text: 'private-response-do-not-save', submit: true, purpose: '保留配置' })
  await p.call('read_tab', { tabId: 'ephemeral' })
  await p.call('send_keys', { tabId: 'ephemeral', key: 'Enter' })
  await p.call('read_tab', { tabId: 'ephemeral' })
  f.memory.checkpoint('owner', f.token, { action: 'confirm_step', step: 1, tabId: 'ephemeral', criteria: 'service healthy', evidence: '当前服务检查通过' })
  const saved = await f.memory.finish('owner', f.token, 'completed', 'complete', 'verified')
  assert.equal(saved.steps[0].policy.interactions[0].mode, 'model')
  assert.match(saved.steps[0].policy.interactions[0].intent, /保留配置/)
  assert.doesNotMatch(JSON.stringify(saved), /private-response|Choose option|Keep current|ephemeral|Enter/)
})

test('condition runner skips a false branch and does not execute its command', async t => {
  const f = await fixture(t, [step({ command: 'do-not-execute', policy: { when: [condition('missing')] } }), step({ id: 'step-2', command: 'check-existing' })])
  const p = ports(f.memory, f.token, [screen('ready'), screen('ready'), screen('ready'), screen('done')])
  const result = await f.runner.run('owner', f.token, 'tab', p)
  assert.equal(result.status, 'awaiting_verification')
  assert.deepEqual(p.calls.filter(c => c.name === 'send_input').map(c => c.args.text), ['check-existing'])
  const state = await f.memory.workflowStatus('owner', '/project')
  assert.deepEqual(state.skippedSteps, [1])
  assert.deepEqual(state.confirmedSteps, [])
  assert.ok(f.memory.completionIssue('owner', f.token))
})

test('saved interaction rule handles the current prompt without an inference call', async t => {
  const f = await fixture(t, [step({ policy: { interactions: [node({ rules: [{ when: [condition('Keep configuration?')], response: { kind: 'answer', text: 'yes' } }] })] } })])
  const p = ports(f.memory, f.token, [screen('initial'), screen('initial'), screen('Keep configuration?', true), screen('Keep configuration?', true), screen('Keep configuration?', true), screen('done')])
  const result = await f.runner.run('owner', f.token, 'tab', p)
  assert.equal(result.status, 'awaiting_verification')
  assert.equal(p.decisions.length, 0)
  assert.equal(p.calls.filter(c => c.args.mode === 'stdin')[0].args.text, 'yes')
  assert.ok(f.memory.completionIssue('owner', f.token), 'reply delivery never completes the logical step')
})

test('unknown interaction uses a helper and a second invocation resumes without repeating the command', async t => {
  const f = await fixture(t, [step({ policy: { interactions: [node()] } })])
  const q = screen('How should configuration be handled?', true)
  const p = ports(f.memory, f.token, [screen('initial'), screen('initial'), q, q, q, screen('working', true)])
  assert.equal((await f.runner.run('owner', f.token, 'tab', p)).status, 'waiting')
  assert.equal(p.decisions.length, 1)
  const again = ports(f.memory, f.token, [screen('done'), screen('done')])
  assert.equal((await f.runner.run('owner', f.token, 'tab', again)).status, 'awaiting_verification')
  assert.equal(again.calls.filter(c => c.name === 'send_input').length, 0)
})

test('an exited process or a changed question discards a slow helper answer', async t => {
  const f = await fixture(t, [step({ policy: { interactions: [node()] } })])
  const q = screen('Keep configuration?', true)
  const p = ports(f.memory, f.token, [screen('initial'), screen('initial'), q, q, screen('shell$')])
  const result = await f.runner.run('owner', f.token, 'tab', p)
  assert.equal(result.status, 'needs_model')
  assert.match(result.reason, /现场已经变化/)
  assert.equal(p.calls.filter(c => c.args.mode === 'stdin').length, 0)
})

test('helper failure and manual policy preserve the pending node', async t => {
  for (const manual of [false, true]) {
    const f = await fixture(t, [step({ policy: { interactions: [node({ mode: manual ? 'manual' : 'model' })] } })])
    const q = screen('Question?', true)
    const p = ports(f.memory, f.token, [screen('initial'), screen('initial'), q, q], () => { throw new Error('helper timeout') })
    assert.equal((await f.runner.run('owner', f.token, 'tab', p)).status, manual ? 'needs_attention' : 'needs_model')
    assert.equal(f.memory.runtime('owner', f.token, 'tab').number, 1)
    assert.equal(p.calls.filter(c => c.args.mode === 'stdin').length, 0)
  }
})

test('independent fresh verification advances fixed steps; old success text cannot pass', async t => {
  for (const fresh of [true, false]) {
    const f = await fixture(t, [step({ verificationCommands: ['health-check'], policy: { verify: { command: 'health-check', expect: [condition('HEALTHY', 'screen')] } } })])
    const done = screen('old HEALTHY\nshell$')
    const after = fresh ? screen('old HEALTHY\nshell$ health-check\nHEALTHY\nshell$') : screen('old HEALTHY\nshell$ health-check\nfailed\nshell$')
    const p = ports(f.memory, f.token, [screen('initial'), screen('initial'), done, after])
    const result = await f.runner.run('owner', f.token, 'tab', p)
    assert.equal(result.status, fresh ? 'complete' : 'awaiting_verification')
    assert.equal(!f.memory.completionIssue('owner', f.token), fresh)
  }
})

test('duplicate interaction observations and unknown-result commands cannot be resent', async t => {
  const f = await fixture(t)
  const q = screen('Question?', true)
  const p = ports(f.memory, f.token, [screen('initial'), screen('initial'), q, q])
  await p.call('read_tab', { tabId: 'tab' })
  await p.call('send_input', { tabId: 'tab', text: 'configure-app', submit: true })
  await p.call('read_tab', { tabId: 'tab' })
  await p.call('send_keys', { tabId: 'tab', key: 'Enter' })
  await p.call('read_tab', { tabId: 'tab' })
  await assert.rejects(p.call('send_keys', { tabId: 'tab', key: 'Enter' }), /未变化/)
  f.memory.markAction('owner', f.token, 'send_input', { text: 'configure-app' })
  await assert.rejects(p.call('send_input', { tabId: 'tab', text: 'configure-app', submit: true }), /结果未知/)
})

test('durable resume keeps steps and unknown actions, drops raw observations, and rebinds the pending terminal', async t => {
  const f = await fixture(t, [step()])
  const p = ports(f.memory, f.token, [screen('initial'), screen('initial'), screen('private terminal data', true)])
  await p.call('read_tab', { tabId: 'old-tab' })
  await p.call('send_input', { tabId: 'old-tab', text: 'configure-app', submit: true })
  f.memory.markAction('owner', f.token, 'send_input', { mode: 'stdin', text: 'private-answer' })
  await f.memory.persistRun('owner')
  const file = path.join(f.root, 'runs', (await fs.promises.readdir(path.join(f.root, 'runs')))[0])
  assert.doesNotMatch(await fs.promises.readFile(file, 'utf8'), /private-answer|private terminal|old-tab/)
  const restored = new TaskMemory(new TaskMemoryStore(f.root))
  assert.equal(await restored.restoreRun('owner', '/project'), true)
  const token = restored.token('owner')
  restored.record('owner', token, 'read_tab', { tabId: 'new-tab' }, screen('completed'))
  restored.checkpoint('owner', token, { action: 'bind_target', tabId: 'new-tab', target: server, evidence: '新终端身份与路径已核对' })
  assert.equal(restored.runtime('owner', token, 'new-tab').pendingTab, 'new-tab')
  restored.checkpoint('owner', token, { action: 'resolve_action', tabId: 'new-tab', outcome: 'sent', evidence: '当前现场已反映回复结果' })
  assert.equal(restored.runtime('owner', token, 'new-tab').uncertain, undefined)
  assert.equal(restored.runtime('owner', token, 'new-tab').pending.command, 'configure-app')
})

function fakeDecision (result, options = {}) {
  const client = new EventEmitter(), captured = [], usage = []
  let disposed = false
  client.respondError = () => {}
  client.close = () => {}
  const backend = { client, connect: async s => captured.push(s), openThread: async () => 'decision-thread', interrupt: async () => {},
    startTurn: async (_id, prompt, _cwd, settings) => {
      captured.push({ prompt, settings })
      if (!options.hang) setImmediate(() => {
        client.emit('event', { method: 'thread/tokenUsage/updated', params: { threadId: 'decision-thread', tokenUsage: { total: { totalTokens: 17 } } } })
        client.emit('event', { method: 'item/completed', params: { threadId: 'decision-thread', item: { type: 'agentMessage', text: JSON.stringify(result) } } })
        client.emit('event', { method: 'turn/completed', params: { threadId: 'decision-thread', turn: { status: 'completed' } } })
      })
      return 'decision-turn'
    } }
  return { backend, captured, usage, disposed: () => disposed, create: async () => ({ backend, dispose: async () => { disposed = true } }) }
}
const decisionInput = () => { const observation = screen('Question?', true); return { objective: 'Keep configuration', node: node(), observation, observationId: observationFingerprint(observation) } }
test('isolated decisions disable tools, account usage and validate node/observation/response', async () => {
  const input = decisionInput()
  const fake = fakeDecision({ nodeId: input.node.id, observationId: input.observationId, action: 'respond', response: { kind: 'answer', text: 'keep' }, reason: 'goal' })
  const settings = { model: 'helper', cwd: '/project', sandbox: 'danger-full-access', threads: { existing: 'main' } }
  const result = await decideWorkflowInteraction(fake.create, settings, input, new AbortController().signal, async delta => fake.usage.push(delta))
  assert.equal(result.response.text, 'keep')
  assert.equal(fake.captured[0].decisionOnly, true)
  assert.equal(fake.captured[0].sandbox, 'read-only')
  assert.deepEqual(fake.captured[0].threads, {})
  assert.deepEqual(settings.threads, { existing: 'main' })
  assert.deepEqual(fake.usage, [17])
  assert.equal(fake.disposed(), true)
  const bad = fakeDecision({ nodeId: 'wrong', observationId: input.observationId, action: 'respond', response: { kind: 'answer', text: 'keep' }, reason: 'goal' })
  await assert.rejects(decideWorkflowInteraction(bad.create, settings, input, new AbortController().signal, async () => {}), /无效/)
})

test('decision timeout and Stop dispose the helper without sending a terminal action', { timeout: 2000 }, async () => {
  for (const cancel of [false, true]) {
    const fake = fakeDecision({}, { hang: true }), controller = new AbortController()
    if (cancel) {
      let releaseInterrupt
      fake.backend.interrupt = () => new Promise(resolve => { releaseInterrupt = resolve })
      fake.backend.client.close = () => releaseInterrupt?.()
    }
    const pending = decideWorkflowInteraction(fake.create, { cwd: '/project', model: 'helper' }, decisionInput(), controller.signal, async () => {}, cancel ? 1000 : 10)
    if (cancel) setTimeout(() => controller.abort(), 5)
    await assert.rejects(pending, cancel ? /取消/ : /超时/)
    assert.equal(fake.disposed(), true)
  }
})

test('structured questions use the current connection helper and add its usage to the parent goal', async t => {
  const f = await fixture(t, [step()]), input = decisionInput()
  let selection, parentTokens = 0
  const factory = { createDecision: async (profileId, settings) => {
    selection = { profileId, settings }
    const fake = fakeDecision({})
    fake.backend.startTurn = async (_id, prompt) => {
      const nodeId = /"nodeId":"([^"]+)"/.exec(prompt)[1], observationId = /"observationId":"([^"]+)"/.exec(prompt)[1]
      setImmediate(() => {
        fake.backend.client.emit('event', { method: 'thread/tokenUsage/updated', params: { threadId: 'decision-thread', tokenUsage: { total: { totalTokens: 17 } } } })
        fake.backend.client.emit('event', { method: 'item/completed', params: { threadId: 'decision-thread', item: { type: 'agentMessage', text: JSON.stringify({ nodeId, observationId, action: 'respond', response: { kind: 'answer', text: 'keep' }, reason: 'goal' }) } } })
        fake.backend.client.emit('event', { method: 'turn/completed', params: { threadId: 'decision-thread', turn: { status: 'completed' } } })
      })
      return 'turn'
    }
    return { backend: fake.backend, dispose: async () => {} }
  } }
  const settings = { cwd: '/project', model: 'primary', reasoningEffort: 'high', workflowHelpers: { current: { model: 'fast-model', reasoningEffort: 'low' } } }
  const result = await runWorkflowTool({ name: 'workflow_question', args: { question: { question: 'Keep?', options: [{ label: 'keep' }] }, policy: { id: 'question-1', intent: 'Keep configuration' } },
    owner: 'owner', token: f.token, profileId: 'current', settings, factory, memory: f.memory, signal: new AbortController().signal, notice: () => {}, call: async () => { throw new Error('not allowed') },
    backend: { getGoal: async () => ({ usedTokens: parentTokens, tokenBudget: 1000 }), accountUsage: async (_id, tokens) => { parentTokens += tokens } } })
  assert.equal(result.response.text, 'keep')
  assert.equal(selection.profileId, 'current')
  assert.equal(selection.settings.model, 'fast-model')
  assert.equal(settings.model, 'primary')
  assert.equal(parentTokens, 17)
})

test('policies reject executable expressions and weak completion-only verification', () => {
  assert.equal(validPolicy({ when: [condition('anything')], code: 'eval()' }), false)
  assert.equal(validPolicy({ verify: { command: 'check', expect: [condition('prompt', 'commandState', 'equals')] } }), false)
  assert.equal(matchesConditions([condition('Question?', 'prompt', 'equals')], screen('old Question?\nnew question')), false)
})

test('recorded sidebar choices retain intent while secret answers become manual nodes', async t => {
  const f = await fixture(t)
  f.memory.recordQuestions('owner', [{ id: 'q1', question: 'Keep configuration?', options: [{ label: 'keep' }, { label: 'replace' }] }, { id: 'q2', question: 'Password?', isSecret: true }],
    { q1: { answers: ['keep'] }, q2: { answers: ['never-save-this-secret'] } })
  const p = ports(f.memory, f.token, [screen('initial'), screen('initial'), screen('finished')])
  await p.call('read_tab', { tabId: 'tab' })
  await p.call('send_input', { tabId: 'tab', text: 'configure-app', submit: true })
  await p.call('read_tab', { tabId: 'tab' })
  f.memory.checkpoint('owner', f.token, { action: 'confirm_step', step: 1, tabId: 'tab', criteria: 'service healthy', evidence: '结果已检查' })
  const saved = await f.memory.finish('owner', f.token, 'completed', 'complete', 'verified')
  assert.equal(saved.questions[0].previousChoice, 'keep')
  assert.equal(saved.questions[1].mode, 'manual')
  assert.doesNotMatch(JSON.stringify(saved), /never-save-this-secret/)
  f.memory.beginExecution('another-owner', saved)
  assert.equal(f.memory.questionPolicy('another-owner', { question: 'Keep configuration?' }).mode, 'model')
  assert.equal(f.memory.questionPolicy('another-owner', { question: 'An unrelated question?' }), undefined)
})

test('only observed interactions gain coverage and saved policy verification cannot invent shell commands', async t => {
  const f = await fixture(t)
  const p = ports(f.memory, f.token, [screen('initial'), screen('initial')])
  await p.call('read_tab', { tabId: 'tab' })
  await p.call('send_input', { tabId: 'tab', text: 'configure-app', submit: true })
  const result = f.memory.configure('owner', f.token, 1, { interactions: [node({ observed: true })] })
  assert.equal(result.policy.interactions[0].observed, false)
  assert.throws(() => f.memory.configure('owner', f.token, 1, { verify: { command: 'invented-check', expect: [condition('HEALTHY')] } }), /已执行过/)
})

test('helper budget exhaustion is reported before a response can be applied', async t => {
  const f = await fixture(t, [step()])
  let creations = 0
  const input = { name: 'workflow_question', args: { question: { question: 'Keep?' }, policy: { id: 'question-1', intent: 'keep' } }, owner: 'owner', token: f.token, profileId: '', settings: { model: 'primary', cwd: '/project' },
    memory: f.memory, signal: new AbortController().signal, notice: () => {}, call: async () => assert.fail('no tools'),
    factory: { createDecision: async () => { creations++; throw new Error('should not create') } }, backend: { getGoal: async () => ({ tokenBudget: 10, usedTokens: 10 }) } }
  await assert.rejects(runWorkflowTool(input), /token 预算/)
  assert.equal(creations, 0)
})

test('a fresh ordinary goal discards an old journal instead of reviving its workflow later', async t => {
  const f = await fixture(t, [step()])
  await f.memory.persistRun('owner')
  f.memory.forgetRun('owner', true)
  await f.memory.discardRunJournal('owner')
  assert.equal(await new TaskMemory(new TaskMemoryStore(f.root)).restoreRun('owner', '/project'), false)
})

test('recovering an unknown submitted command never inherits the template success evidence', async t => {
  const f = await fixture(t, [step()])
  f.memory.markAction('owner', f.token, 'send_input', { text: 'configure-app', purpose: 'configure' })
  f.memory.record('owner', f.token, 'read_tab', { tabId: 'tab' }, screen('operation may have completed'))
  f.memory.checkpoint('owner', f.token, { action: 'resolve_action', tabId: 'tab', outcome: 'sent', evidence: '现场确认操作已提交，等待验收' })
  assert.equal(f.memory.runtime('owner', f.token, 'tab').pending.verification, undefined)
  assert.ok(f.memory.completionIssue('owner', f.token))
})
