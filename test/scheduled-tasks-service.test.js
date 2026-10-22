const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const Module = require('node:module')
const { EventEmitter } = require('node:events')
const { Subject, AsyncSubject } = require('rxjs')
const ts = require('typescript')
const originalLoad = Module._load
const originalExtension = require.extensions['.ts']
Module._load = function(request, parent, isMain) {
  if (request === '@angular/core') return { Injectable: () => target => target }
  if (['tabby-core', './agent-backend.service', './tab-tools'].includes(request)) return {}
  return originalLoad.call(this, request, parent, isMain)
}
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, experimentalDecorators: true },
}).outputText, filename)
const { ScheduledTasksService } = require('../src/scheduled-tasks.service.ts')
Module._load = originalLoad
require.extensions['.ts'] = originalExtension
const settings = { executable: 'codex', model: 'saved-model', approvalPolicy: 'on-request', sandbox: 'read-only', reasoningEffort: 'high', threads: {}, goalTokenBudget: 0 }
const args = { title: '巡检', instructions: '只读检查服务状态并验证结果', scheduleType: 'interval', intervalMinutes: 1 }

async function fixture(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tabby-schedule-service-'))
  const starts = [], notifications = [], readiness = new Subject(), cleanups = []
  const windowEvents = new Map()
  const previousWindow = global.window
  global.window = { addEventListener: (name, handler) => windowEvents.set(name, handler), removeEventListener: name => windowEvents.delete(name) }
  const agents = { defaultProfileId: 'api', probeModel: async (_id, settings) => ({ ok: true, model: settings.model, reasoningEffort: settings.reasoningEffort, testedAt: Date.now(), totalTokens: 3 }), create: id => {
    const client = new EventEmitter()
    const backend = { client, ...(id ? { profile: { id, model: 'changed-model', reasoningEffort: 'low' } } : {}),
      listModels: async () => [{ model: 'configured-basic', displayName: 'Configured model' }, { model: 'gpt-6-sol', displayName: 'GPT-6 Sol', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }, { model: 'reasoning-model', displayName: 'Reasoning model', description: 'Supports multi-step reasoning and tool use', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }],
      connect: async () => {}, openThread: async () => 'background-thread', interrupt: async () => {},
      startTurn: async (threadId, text, cwd, savedSettings) => {
        starts.push({ threadId, text, cwd, settings: savedSettings, model: backend.profile?.model || savedSettings.model })
        setImmediate(() => client.emit('event', { id: 1, method: 'item/tool/call', params: { threadId, namespace: 'tabby_tasks', tool: 'scheduled_task_finish', arguments: { status: 'completed', evidence: '只读巡检通过' } } }))
        return 'turn-1'
      },
    }
    client.respond = () => setImmediate(() => client.emit('event', { method: 'turn/completed', params: { threadId: 'background-thread', turn: { id: 'turn-1', status: 'completed' } } }))
    client.respondError = (_id, message) => { throw new Error(message) }
    client.close = () => {}
    return backend
  } }
  const connections = [
    { profileId: '', name: 'Codex', provider: 'codex', model: 'saved-model', reasoningEffort: 'high' },
    { profileId: 'api', name: 'API', provider: 'deepseek', model: 'configured-basic', reasoningEffort: '' },
    { profileId: 'advanced', name: 'Advanced', provider: 'claude', model: 'configured-basic', reasoningEffort: 'high' },
  ]
  agents.modelConnections = () => connections
  const config = { ready$: readiness, store: { codexAgent: { defaultProfileId: 'api' } } }
  const service = new ScheduledTasksService(config, { getConfigPath: () => path.join(root, 'config.yaml') }, agents,
    { call: async () => assert.fail('no terminal needed'), releaseOwner: () => {} },
    { error: (...args) => notifications.push(args), notice: (...args) => notifications.push(args) })
  t.after(async () => { for (const cleanup of cleanups) cleanup(); service.ngOnDestroy(); global.window = previousWindow; await fs.promises.rm(root, { recursive: true, force: true }) })
  return { root, service, agents, readiness, starts, notifications, windowEvents, config, connections, cleanups }
}
async function waitFor(condition) {
  for (let i = 0; i < 200; i++) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  throw new Error('timed out')
}

test('scheduler starts at config readiness and runs without creating any chat panel', async t => {
  const f = await fixture(t)
  await f.service.store.create(args, '/workspace', 'api-profile', settings, Date.now() - 2 * 60000)
  assert.equal(f.agents.scheduler, f.service)
  f.service.start()
  assert.equal(f.starts.length, 0)
  f.readiness.next()
  await waitFor(async () => (await f.service.store.read()).runs.some(run => run.status === 'completed'))
  await waitFor(() => !f.service.runner)
  assert.equal(f.starts.length, 1)
  assert.equal(f.starts[0].cwd, '/workspace')
  assert.equal(f.starts[0].model, 'saved-model')
  assert.equal(f.starts[0].settings.approvalPolicy, 'never')
  assert.equal(f.starts[0].settings.sandbox, 'read-only')
  assert.deepEqual(f.starts[0].settings.threads, {})
  assert.equal(f.notifications.length, 0)
  f.windowEvents.get('unload')()
  assert.equal(f.service.stopped, true)
})

test('task tools expose time context and keep queries scoped to the current directory', async t => {
  const f = await fixture(t)
  const created = await f.service.call('scheduled_task_create', args, '/workspace', 'api', settings)
  assert.ok(created.result.id)
  assert.ok(created.nextRunAt.endsWith('Z'))
  assert.ok(created.now.endsWith('Z'))
  assert.ok(created.localTimezone)
  assert.equal((await f.service.call('scheduled_task_list', {}, '/workspace', 'api', settings)).result.length, 1)
  assert.equal((await f.service.call('scheduled_task_list', {}, '/elsewhere', 'api', settings)).result.length, 0)
  await assert.rejects(f.service.call('scheduled_task_runs', { taskId: created.result.id }, '/elsewhere', 'api', settings), /找不到/)
  await f.service.call('scheduled_task_update', { taskId: created.result.id, enabled: false }, '/workspace', 'api', settings)
  assert.equal((await f.service.store.read()).tasks[0].enabled, false)
  assert.equal(f.starts.length, 0)
})

test('task callers cannot forge a successful readiness check', async t => {
  const f = await fixture(t)
  await assert.rejects(f.service.call('scheduled_task_create', {
    ...args, modelCheck: { fallbackUsed: false, requestedModel: 'unverified-model', testedAt: Date.now() },
  }, '/workspace', 'api', settings), /只能由插件实际测试生成/)
  assert.equal((await f.service.store.read()).tasks.length, 0)
})

test('removed connection fails visibly and pauses the task without replacing it with another provider', async t => {
  const f = await fixture(t)
  const task = await f.service.store.create(args, '/workspace', 'removed-profile', settings)
  f.agents.create = () => { throw new Error('找不到所选 API 连接') }
  await f.service.runNow(task.id, '/workspace')
  await waitFor(async () => (await f.service.store.read()).runs.some(run => run.status === 'failed'))
  await waitFor(() => !f.service.runner)
  const data = await f.service.store.read()
  assert.equal(data.tasks[0].enabled, false)
  assert.match(data.runs[0].summary, /找不到/)
  assert.equal(f.notifications.length, 1)
})

test('a view refresh error cannot misreport an already saved task as a failed creation', async t => {
  const f = await fixture(t)
  f.service.refresh = async () => { throw new Error('view refresh failed') }
  const created = await f.service.call('scheduled_task_create', args, '/workspace', 'api', settings)
  assert.ok(created.result.id)
  assert.equal((await f.service.store.read()).tasks.length, 1)
})

test('idle polling avoids rereading unchanged execution logs and detects writes from another window', async t => {
  const f = await fixture(t)
  await f.service.refresh()
  const originalRead = f.service.store.read.bind(f.service.store)
  let reads = 0
  f.service.store.read = async () => { reads++; return originalRead() }
  await f.service.tick()
  await f.service.tick()
  assert.equal(reads, 0)
  await f.service.store.create(args, '/workspace', 'api', settings)
  reads = 0
  await f.service.tick()
  assert.equal(reads, 1)
  assert.equal(f.service.changes$.value.tasks.length, 1)
})

test('task model discovery exposes connections and live IDs without starting inference', async t => {
  const f = await fixture(t)
  const response = await f.service.call('scheduled_task_models', { profileId: 'advanced' }, '/workspace', 'api', settings)
  assert.equal(response.result.profileId, 'advanced')
  assert.equal(response.result.connections.length, 3)
  assert.ok(response.result.models.some(model => model.model === 'reasoning-model'))
  assert.match(response.result.notice, /不提供可靠的能力排名/)
  assert.equal(f.starts.length, 0)
})

test('a task can choose another connection and model, execute it and record why without changing defaults', async t => {
  const f = await fixture(t)
  const configBefore = JSON.stringify(f.config.store)
  const reason = '用户要求质量优先；候选描述支持多步推理与工具。当前没有价格或延迟对比数据。'
  const response = await f.service.call('scheduled_task_create', { ...args, profileId: 'advanced', model: 'reasoning-model', reasoningEffort: 'high', selectionReason: reason }, '/workspace', 'api', settings)
  const task = response.result
  assert.equal(task.profileId, 'advanced')
  assert.equal(task.settings.model, 'reasoning-model')
  assert.equal(task.settings.sandbox, 'read-only')
  assert.equal(task.settings.approvalPolicy, 'on-request')
  assert.equal(task.modelSelectionReason, reason)
  await f.service.runNow(task.id, '/workspace')
  await waitFor(async () => (await f.service.store.read()).runs.some(run => run.status === 'completed'))
  await waitFor(() => !f.service.runner)
  assert.equal(f.starts[0].model, 'reasoning-model')
  const record = (await f.service.store.read()).runs[0]
  assert.equal(record.model, 'reasoning-model')
  assert.equal(record.profileId, 'advanced')
  assert.equal(record.modelSelectionReason, reason)
  assert.ok(record.entries.some(entry => /reasoning-model/.test(entry.text) && /质量优先/.test(entry.text)))
  assert.equal(JSON.stringify(f.config.store), configBefore)
  assert.equal(settings.model, 'saved-model')
})

test('model changes apply to the workspace task and future runs, preserving active run metadata and permissions', async t => {
  const f = await fixture(t)
  const task = await f.service.store.create(args, '/workspace', 'api', settings)
  const first = await f.service.store.claim('test-owner', Date.now(), task.id, '/workspace')
  const response = await f.service.call('scheduled_task_set_model', { taskId: task.id, profileId: 'advanced', model: 'reasoning-model', reasoningEffort: 'low', reason: '本次任务需要多步判断', sandbox: 'danger-full-access' }, '/workspace', 'api', settings)
  assert.match(response.result.effective, /下次运行/)
  let data = await f.service.store.read()
  assert.equal(data.tasks[0].settings.model, 'reasoning-model')
  assert.equal(data.tasks[0].settings.sandbox, 'read-only')
  assert.equal(data.tasks[0].settings.approvalPolicy, 'on-request')
  assert.equal(data.runs[0].model, 'saved-model')
  assert.equal(first.task.settings.model, 'saved-model')
  await f.service.store.mutateRun(first.run.id, 'test-owner', run => { run.status = 'completed' })
  const second = await f.service.store.claim('test-owner', Date.now(), task.id, '/workspace')
  assert.equal(second.run.model, 'reasoning-model')
  assert.equal(second.run.modelSelectionReason, '本次任务需要多步判断')
  await f.service.store.mutateRun(second.run.id, 'test-owner', run => { run.status = 'completed' })
})

test('invented models, missing reasons, invalid effort and cross-workspace model changes cannot update a task', async t => {
  const f = await fixture(t)
  const task = await f.service.store.create(args, '/workspace', 'api', settings)
  const before = JSON.stringify(await f.service.store.read())
  for (const override of [{ model: 'made-up-model', reason: 'try' }, { model: 'reasoning-model' }, { model: 'reasoning-model', reasoningEffort: 'unsupported', reason: 'try' }, { profileId: 'missing', model: 'reasoning-model', reason: 'try' }]) {
    await assert.rejects(f.service.call('scheduled_task_set_model', { taskId: task.id, ...override }, '/workspace', 'api', settings))
  }
  await assert.rejects(f.service.call('scheduled_task_set_model', { taskId: task.id, model: 'reasoning-model', reason: 'try' }, '/other-workspace', 'api', settings), /找不到/)
  assert.equal(JSON.stringify(await f.service.store.read()), before)
})

test('unavailable model discovery is explicit and can retain an already configured model', async t => {
  const f = await fixture(t)
  const originalCreate = f.agents.create
  f.agents.create = id => { const backend = originalCreate(id); backend.listModels = async () => { throw new Error('model endpoint unavailable') }; return backend }
  const listed = await f.service.call('scheduled_task_models', { profileId: 'advanced' }, '/workspace', 'api', settings)
  assert.deepEqual(listed.result.models, [])
  assert.match(listed.result.discoveryError, /unavailable/)
  assert.equal(listed.result.configuredModel, 'configured-basic')
  const created = await f.service.call('scheduled_task_create', { ...args, profileId: 'advanced', model: 'configured-basic', selectionReason: '用户选择此连接已有配置；列表不可用，无法比较其他模型。' }, '/workspace', 'api', settings)
  assert.equal(created.result.settings.model, 'configured-basic')
  assert.equal(created.result.profileId, 'advanced')
})

test('explicit native Codex gpt-6-sol/high is tested before saving and reaches the task turn unchanged', async t => {
  const f = await fixture(t)
  const tested = []
  f.agents.probeModel = async (profileId, settings) => { tested.push({ profileId, model: settings.model, effort: settings.reasoningEffort }); return { ok: true, model: settings.model, reasoningEffort: settings.reasoningEffort, testedAt: Date.now(), totalTokens: 4 } }
  const created = await f.service.call('scheduled_task_create', { ...args, profileId: '', model: 'gpt-6-sol', reasoningEffort: 'high', selectionReason: '用户明确指定 Codex GPT-6 Sol 和 high' }, '/workspace', 'api', settings)
  assert.deepEqual(tested[0], { profileId: '', model: 'gpt-6-sol', effort: 'high' })
  assert.equal(created.result.settings.model, 'gpt-6-sol')
  assert.equal(created.result.settings.reasoningEffort, 'high')
  assert.equal(created.result.modelCheck.fallbackUsed, false)
  await f.service.runNow(created.result.id, '/workspace')
  await waitFor(async () => (await f.service.store.read()).runs.some(run => run.status === 'completed'))
  await waitFor(() => !f.service.runner && !f.service.preflight)
  assert.equal(tested.length, 2, 'a changed task model is checked again before execution')
  assert.equal(f.starts[0].settings.model, 'gpt-6-sol')
  assert.equal(f.starts[0].settings.reasoningEffort, 'high')
})

test('failed candidate test saves only a tested plugin default and records the fallback', async t => {
  const f = await fixture(t)
  const tested = []
  f.agents.probeModel = async (profileId, settings) => {
    tested.push(profileId)
    return { ok: profileId === 'api', model: settings.model, reasoningEffort: settings.reasoningEffort, testedAt: Date.now(), totalTokens: 3, ...(profileId === 'api' ? {} : { error: 'candidate unsupported' }) }
  }
  const task = await f.service.store.create(args, '/workspace', 'api', settings)
  const changed = await f.service.call('scheduled_task_set_model', { taskId: task.id, profileId: 'advanced', model: 'reasoning-model', reason: '用户要求更强的诊断模型' }, '/workspace', 'api', settings)
  assert.deepEqual(tested, ['advanced', 'api'])
  assert.equal(changed.result.task.profileId, 'api')
  assert.equal(changed.result.task.settings.model, 'configured-basic')
  assert.equal(changed.result.task.modelCheck.fallbackUsed, true)
  assert.equal(changed.result.task.modelCheck.requestedModel, 'reasoning-model')
  assert.match(changed.result.task.modelCheck.candidateError, /unsupported/)
  assert.equal(changed.result.task.settings.sandbox, 'read-only')
})

test('candidate and default failure keep the existing task model and never start task actions', async t => {
  const f = await fixture(t)
  const task = await f.service.store.create(args, '/workspace', 'api', settings)
  const before = JSON.stringify(await f.service.store.read())
  let tests = 0
  f.agents.probeModel = async (_id, settings) => { tests++; return { ok: false, model: settings.model, reasoningEffort: settings.reasoningEffort, testedAt: Date.now(), totalTokens: 0, error: 'unavailable' } }
  await assert.rejects(f.service.call('scheduled_task_set_model', { taskId: task.id, profileId: 'advanced', model: 'reasoning-model', reason: 'try better model' }, '/workspace', 'api', settings), /默认模型也未通过/)
  assert.equal(tests, 2)
  assert.equal(JSON.stringify(await f.service.store.read()), before)
  assert.equal(f.starts.length, 0)
})

test('failure at runtime falls back before any task turn and preserves the requested model in the run log', async t => {
  const f = await fixture(t)
  const task = await f.service.store.create({ ...args, selectionReason: '用户要求诊断能力优先' }, '/workspace', 'advanced', { ...settings, model: 'reasoning-model' })
  f.agents.probeModel = async (profileId, settings) => ({ ok: profileId === 'api', model: settings.model, reasoningEffort: settings.reasoningEffort, testedAt: Date.now(), totalTokens: 2, ...(profileId === 'api' ? {} : { error: 'candidate rate limited' }) })
  await f.service.runNow(task.id, '/workspace')
  await waitFor(async () => (await f.service.store.read()).runs.some(run => run.status === 'completed'))
  await waitFor(() => !f.service.runner && !f.service.preflight)
  assert.equal(f.starts.length, 1)
  assert.equal(f.starts[0].model, 'configured-basic')
  const record = (await f.service.store.read()).runs[0]
  assert.equal(record.modelCheck.requestedModel, 'reasoning-model')
  assert.equal(record.modelCheck.fallbackUsed, true)
  assert.equal(record.model, 'configured-basic')
  assert.match(record.modelCheck.candidateError, /rate limited/)
  assert.equal(record.probeTokens, 4)
  assert.ok(record.entries.some(entry => /回退/.test(entry.text)))
})

test('cancelling a preflight model test interrupts the run without trying a fallback', async t => {
  const f = await fixture(t)
  const task = await f.service.store.create({ ...args, selectionReason: 'explicit selection' }, '/workspace', 'advanced', settings)
  let entered, tests = 0
  const ready = new Promise(resolve => { entered = resolve })
  f.agents.probeModel = (_id, _settings, signal) => new Promise((_resolve, reject) => {
    tests++
    signal.addEventListener('abort', () => reject(new Error('模型测试已取消')), { once: true })
    entered()
  })
  await f.service.runNow(task.id, '/workspace')
  await ready
  const run = (await f.service.store.read()).runs[0]
  f.service.stopRun(run.id)
  await waitFor(async () => (await f.service.store.read()).runs[0].status === 'interrupted')
  await waitFor(() => !f.service.preflight)
  assert.equal(tests, 1)
  assert.equal(f.starts.length, 0)
})

test('a temporary setup failure retains the preferred model and retries it on the next run', async t => {
  const f = await fixture(t)
  let recovered = false
  const tested = []
  f.agents.probeModel = async (profileId, settings) => {
    tested.push(profileId)
    const ok = profileId === 'api' || recovered
    return { ok, model: settings.model, reasoningEffort: settings.reasoningEffort, testedAt: Date.now(), totalTokens: 2, ...(ok ? {} : { error: 'temporary outage' }) }
  }
  const created = await f.service.call('scheduled_task_create', { ...args, profileId: 'advanced', model: 'reasoning-model', selectionReason: '用户指定首选模型' }, '/workspace', 'api', settings)
  assert.equal(created.result.modelCheck.fallbackUsed, true)
  assert.equal(created.result.modelCheck.requestedModel, 'reasoning-model')
  recovered = true
  await f.service.runNow(created.result.id, '/workspace')
  await waitFor(async () => (await f.service.store.read()).runs.some(run => run.status === 'completed'))
  await waitFor(() => !f.service.runner && !f.service.preflight)
  const record = (await f.service.store.read()).runs[0]
  assert.deepEqual(tested, ['advanced', 'api', 'advanced'])
  assert.equal(record.model, 'reasoning-model')
  assert.equal(record.modelCheck.fallbackUsed, false)
  assert.equal(f.starts[0].model, 'reasoning-model')
})

for (const variant of ['candidate-over', 'fallback-exact', 'below', 'both-fail']) {
  test(`preflight usage ${variant} is durable and gates task execution`, async t => {
    const f = await fixture(t)
    const probes = []
    const candidateTokens = variant === 'candidate-over' ? 600 : variant === 'both-fail' ? 120 : 300
    const fallbackTokens = variant === 'below' ? 199 : variant === 'both-fail' ? 180 : 200
    f.agents.probeModel = async (id, config) => {
      probes.push(id)
      return { ok: id === 'api' && variant !== 'both-fail', model: config.model, reasoningEffort: config.reasoningEffort,
        testedAt: Date.now(), totalTokens: id === 'api' ? fallbackTokens : candidateTokens, error: 'tool validation failed' }
    }
    const task = await f.service.store.create({ ...args, selectionReason: 'explicit model' }, '/workspace', 'advanced', { ...settings, goalTokenBudget: 500 })
    await f.service.runNow(task.id, '/workspace')
    await waitFor(async () => (await f.service.store.read()).runs.some(run => ['completed', 'needs_attention', 'failed'].includes(run.status)))
    await waitFor(() => !f.service.runner && !f.service.preflight)
    const data = await f.service.store.read(), run = data.runs[0]
    assert.deepEqual(probes, variant === 'candidate-over' ? ['advanced'] : ['advanced', 'api'])
    const tokens = variant === 'candidate-over' ? candidateTokens : candidateTokens + fallbackTokens
    assert.equal(run.probeTokens, tokens)
    assert.equal(run.totalTokens, tokens)
    assert.ok(run.entries.some(entry => entry.text.includes(`累计 ${tokens} tokens`)))
    assert.equal(f.starts.length, variant === 'below' ? 1 : 0)
    assert.equal(run.status, variant === 'below' ? 'completed' : variant === 'both-fail' ? 'failed' : 'needs_attention')
    if (variant !== 'below') assert.equal(data.tasks[0].enabled, false)
  })
}

test('a probe log write failure cannot erase already reported usage', async t => {
  const f = await fixture(t)
  const task = await f.service.store.create({ ...args, selectionReason: 'explicit' }, '/workspace', 'advanced', settings)
  f.agents.probeModel = async () => ({ ok: false, totalTokens: 600, error: 'invalid tool', testedAt: Date.now(), model: 'fixture', reasoningEffort: '' })
  const append = f.service.store.append.bind(f.service.store)
  f.service.store.append = (...args) => args[3].startsWith('模型测试用量') ? Promise.reject(new Error('log write failed')) : append(...args)
  await f.service.runNow(task.id, '/workspace')
  await waitFor(async () => (await f.service.store.read()).runs[0]?.status === 'failed')
  await waitFor(() => !f.service.preflight)
  const run = (await f.service.store.read()).runs[0]
  assert.equal(run.probeTokens, 600)
  assert.equal(run.totalTokens, 600)
  assert.match(run.summary, /log write failed/)
  assert.equal(f.starts.length, 0)
})

test('restarting reloads plans before opening a panel, coalesces missed triggers and keeps paused tasks', async t => {
  const f = await fixture(t)
  const overdue = await f.service.store.create(args, '/workspace', 'api', settings, Date.now() - 5 * 60000)
  const paused = await f.service.store.create(args, '/other', 'api', settings, Date.now() - 5 * 60000)
  await f.service.setEnabled(paused.id, paused.cwd, false)
  const deleted = await f.service.store.create(args, '/deleted', 'api', settings, Date.now() - 5 * 60000)
  await f.service.remove(deleted.id, deleted.cwd)
  f.service.ngOnDestroy()
  // Tabby may have completed configuration readiness before loading the module.
  const ready = new AsyncSubject()
  ready.next(true); ready.complete()
  const restarted = new ScheduledTasksService({ ...f.config, ready$: ready }, { getConfigPath: () => path.join(f.root, 'config.yaml') }, f.agents,
    { call: async () => assert.fail('no terminal needed'), releaseOwner: () => {} },
    { error: (...args) => assert.fail(args.join(' ')) })
  f.cleanups.push(() => restarted.ngOnDestroy())
  restarted.start()
  await waitFor(async () => restarted.changes$.value.runs.some(run => run.status === 'completed'))
  await waitFor(() => !restarted.runner && !restarted.preflight)
  await restarted.tick()
  assert.equal(f.starts.length, 1)
  const data = restarted.changes$.value
  assert.equal(data.tasks.length, 2)
  assert.equal(data.runs.length, 1)
  assert.equal(data.runs[0].taskId, overdue.id)
  assert.ok(data.tasks.find(t => t.id === overdue.id).nextRunAt > Date.now())
  assert.equal(data.tasks.find(t => t.id === paused.id).enabled, false)
})

test('restart retires expired in-progress execution without replaying terminal actions', async t => {
  const f = await fixture(t)
  const task = await f.service.store.create(args, '/workspace', 'api', settings, Date.now() - 5 * 60000)
  await f.service.store.claim('dead-window', Date.now(), task.id, task.cwd)
  await f.service.store.update(data => { data.runs[0].leaseUntil = Date.now() - 1 })
  f.service.ngOnDestroy()
  const restarted = new ScheduledTasksService(f.config, { getConfigPath: () => path.join(f.root, 'config.yaml') }, f.agents, {}, { error: (...args) => assert.fail(args.join(' ')) })
  f.cleanups.push(() => restarted.ngOnDestroy())
  restarted.start(); f.readiness.next(true)
  await waitFor(async () => restarted.changes$.value.runs[0]?.status === 'interrupted')
  assert.equal(f.starts.length, 0)
  assert.equal(restarted.changes$.value.tasks[0].enabled, false)
})
