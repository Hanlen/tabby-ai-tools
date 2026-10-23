const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const ts = require('typescript')
const original = require.extensions['.ts']
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
}).outputText, filename)
const { ScheduledTaskStore, parseSchedule, nextOccurrence } = require('../src/scheduled-tasks.ts')
const { ScheduledWorkflowRunner } = require('../src/scheduled-workflow-runner.ts')
const { SCHEDULE_TOOLS } = require('../src/scheduled-task-tools.ts')
require.extensions['.ts'] = original

const settings = { executable: 'codex', model: 'fixture-model', reasoningEffort: 'high', approvalPolicy: 'on-request', sandbox: 'workspace-write', goalTokenBudget: 0 }
const args = { title: '服务巡检', instructions: '检查 production 主机的 app 服务，异常时读日志再决定是否重启，最多重试三次，验证服务恢复。', scheduleType: 'interval', intervalMinutes: 5 }
async function fixture(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tabby-scheduled-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const store = new ScheduledTaskStore(root)
  return { root, store }
}

function backend(script) {
  const client = new EventEmitter()
  const pending = new Map()
  let nextRequest = 0, round = 0
  const agent = { client,
    connect: async () => {}, openThread: async () => 'scheduled-thread',
    startTurn: async (_thread, text) => {
      const number = ++round
      const turnId = `turn-${number}`
      setImmediate(async () => {
        event('turn/started', { turn: { id: turnId } })
        try { await script({ ask, event, round: number, text }); event('turn/completed', { turn: { id: turnId, status: 'completed' } }) }
        catch (error) { event('turn/completed', { turn: { id: turnId, status: 'failed', error: { message: error.message } } }) }
      })
      return turnId
    },
    interrupt: async () => { for (const request of pending.values()) request.reject(new Error('stopped')); pending.clear() },
  }
  function event(method, params) { client.emit('event', { method, params: { ...params, threadId: 'scheduled-thread' } }) }
  function ask(tool, arguments_, namespace = 'tabby_tabs', method = 'item/tool/call', extra = {}) {
    const id = ++nextRequest
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      client.emit('event', { id, method, params: { threadId: 'scheduled-thread', namespace, tool, arguments: arguments_, reason: '检查后重启服务', ...extra } })
    })
  }
  client.respond = (id, result) => { pending.get(id)?.resolve(result); pending.delete(id) }
  client.respondError = (id, message) => { pending.get(id)?.reject(new Error(message)); pending.delete(id) }
  return agent
}
async function claim(t) {
  const f = await fixture(t)
  await f.store.create(args, '/project', '', settings)
  const job = await f.store.claim('window-one', Date.now(), (await f.store.read()).tasks[0].id, '/project')
  return { ...f, ...job }
}
const output = result => JSON.parse(result.contentItems[0].text)

test('atomic schedule updates retry sharing violations without reapplying changes or removing the previous file', async t => {
  const f = await fixture(t)
  await f.store.create(args, '/project', '', settings)
  const previous = await fs.promises.readFile(f.store.file, 'utf8')
  const originalRename = fs.promises.rename
  const failures = ['EPERM', 'EACCES', 'EBUSY']
  let attempts = 0, changes = 0
  t.mock.method(fs.promises, 'rename', async (from, to) => {
    if (to === f.store.file) {
      attempts++
      if (failures.length) {
        assert.equal(await fs.promises.readFile(to, 'utf8'), previous)
        throw Object.assign(new Error('temporary sharing violation'), { code: failures.shift() })
      }
    }
    return originalRename(from, to)
  })
  await f.store.update(data => { changes++; data.tasks[0].title = 'updated after retry' })
  assert.equal(changes, 1)
  assert.equal(attempts, 4)
  assert.equal((await new ScheduledTaskStore(f.root).read()).tasks[0].title, 'updated after retry')
  assert.deepEqual(await fs.promises.readdir(f.root), ['scheduled-tasks.json'])
})

test('permanent replacement errors are bounded, preserve the previous schedule and clean up the lock', async t => {
  const f = await fixture(t)
  await f.store.create(args, '/project', '', settings)
  const previous = await fs.promises.readFile(f.store.file, 'utf8')
  const originalRename = fs.promises.rename
  let code = 'EIO', attempts = 0, changes = 0
  const mock = t.mock.method(fs.promises, 'rename', async (from, to) => {
    if (to === f.store.file) { attempts++; throw Object.assign(new Error('replacement failed'), { code }) }
    return originalRename(from, to)
  })
  await assert.rejects(f.store.update(data => { changes++; data.tasks[0].title = 'must not persist' }), { code: 'EIO' })
  assert.equal(attempts, 1)
  code = 'EPERM'; attempts = 0
  await assert.rejects(f.store.update(data => { changes++; data.tasks[0].title = 'still must not persist' }), { code: 'EPERM' })
  assert.equal(attempts, 9)
  assert.equal(changes, 2)
  assert.equal(await fs.promises.readFile(f.store.file, 'utf8'), previous)
  assert.deepEqual(await fs.promises.readdir(f.root), ['scheduled-tasks.json'])
  mock.mock.restore()
  await f.store.update(data => { data.tasks[0].title = 'recovered' })
  assert.equal((await f.store.read()).tasks[0].title, 'recovered')
})

test('schedule validation requires explicit offsets, future instants, and valid intervals/timezones', () => {
  const now = Date.parse('2026-10-22T00:00:00Z')
  assert.throws(() => parseSchedule({ scheduleType: 'at', at: '2026-10-23T09:00:00' }, now), /ISO/)
  assert.throws(() => parseSchedule({ scheduleType: 'at', at: '2026-10-21T09:00:00+08:00' }, now), /未来/)
  assert.equal(parseSchedule({ scheduleType: 'at', at: '2026-10-23T09:00:00+08:00' }, now).at, Date.parse('2026-10-23T01:00:00Z'))
  for (const intervalMinutes of [0, 1.1, -1, 525601, '5']) assert.throws(() => parseSchedule({ scheduleType: 'interval', intervalMinutes }, now))
  assert.throws(() => parseSchedule({ scheduleType: 'daily', time: '24:00', timezone: 'Asia/Shanghai' }, now))
  assert.throws(() => parseSchedule({ scheduleType: 'daily', time: '09:00', timezone: 'Bogus/Timezone' }, now))
})

test('daily schedules respect timezone and daylight-saving gaps and avoid double execution on fall-back', () => {
  const shanghai = { type: 'daily', time: '09:00', timezone: 'Asia/Shanghai' }
  assert.equal(new Date(nextOccurrence(shanghai, Date.parse('2026-10-22T00:59:00Z'))).toISOString(), '2026-10-22T01:00:00.000Z')
  assert.equal(new Date(nextOccurrence(shanghai, Date.parse('2026-10-22T01:00:00Z'))).toISOString(), '2026-10-23T01:00:00.000Z')
  const gap = { type: 'daily', time: '02:30', timezone: 'America/New_York' }
  assert.equal(new Date(nextOccurrence(gap, Date.parse('2026-03-08T05:00:00Z'))).toISOString(), '2026-03-09T06:30:00.000Z')
  const repeat = { type: 'daily', time: '01:30', timezone: 'America/New_York' }
  assert.equal(new Date(nextOccurrence(repeat, Date.parse('2026-11-01T05:30:00Z'))).toISOString(), '2026-11-02T06:30:00.000Z')
})

test('multiple windows atomically claim one occurrence and missed intervals coalesce without drifting', async t => {
  const { root, store } = await fixture(t)
  const now = Date.now()
  const task = await store.create(args, '/project', '', settings, now - 17 * 60000)
  const second = new ScheduledTaskStore(root)
  const results = await Promise.all([store.claim('window-one', now), second.claim('window-two', now)])
  assert.equal(results.filter(Boolean).length, 1)
  const data = await store.read()
  assert.equal(data.runs.length, 1)
  assert.equal(data.runs[0].scheduledAt, task.createdAt + 5 * 60000)
  assert.equal(data.tasks[0].nextRunAt, task.createdAt + 20 * 60000)
  assert.equal(await second.claim('window-two', now + 1000), undefined)
})

test('expired execution is interrupted and paused, never automatically replayed', async t => {
  const { store, task, run } = await claim(t)
  await store.update(data => { data.runs[0].leaseUntil = Date.now() - 1; data.tasks[0].nextRunAt = Date.now() - 1 })
  assert.equal(await store.claim('another-window'), undefined)
  const data = await store.read()
  assert.equal(data.runs[0].status, 'interrupted')
  assert.match(data.runs[0].summary, /未自动重放/)
  assert.equal(data.tasks[0].enabled, false)
  await assert.rejects(store.append(run.id, run.owner, 'action', 'must not run'), /租约/)
  assert.equal(data.tasks[0].id, task.id)
})

test('creation snapshots permissions and strips keys, profiles and interactive conversation IDs', async t => {
  const { store } = await fixture(t)
  const task = await store.create(args, '/project', 'my-api', { ...settings, apiProfiles: [{ apiKey: 'DO_NOT_COPY' }], threads: { '/project': 'foreground-thread' } })
  const serialized = JSON.stringify(await store.read())
  assert.equal(task.settings.approvalPolicy, 'on-request')
  assert.equal(task.settings.model, 'fixture-model')
  assert.doesNotMatch(serialized, /DO_NOT_COPY|foreground-thread/)
  await assert.rejects(store.create({ ...args, instructions: 'curl --header Bearer sk-abcdefghijklmnop' }, '/project', '', settings), /凭据/)
  await assert.rejects(store.setEnabled(task.id, '/other-project', false), /找不到/)
})

test('corrupt schedule file is reported without overwriting it', async t => {
  const { store } = await fixture(t)
  await fs.promises.writeFile(store.file, '{broken')
  await assert.rejects(store.create(args, '/project', '', settings))
  assert.equal(await fs.promises.readFile(store.file, 'utf8'), '{broken')
})

test('scheduled workflow repeatedly observes output, branches, executes and saves verified results', async t => {
  const f = await claim(t)
  const calls = [], released = []
  const agent = backend(async ({ ask, event, text }) => {
    assert.match(text, /独立执行|本次定时任务/)
    const first = output(await ask('read_tab', { tabId: 'fresh' }))
    if (first.text === 'unhealthy') await ask('send_input', { tabId: 'fresh', text: 'systemctl restart app', submit: true })
    const verified = output(await ask('read_tab', { tabId: 'fresh' }))
    assert.equal(verified.text, 'healthy')
    event('item/completed', { item: { id: 'summary', type: 'agentMessage', text: '服务已恢复，健康检查通过' } })
    await ask('scheduled_task_finish', { status: 'completed', evidence: '重启后再次检查，服务返回 healthy' }, 'tabby_tasks')
  })
  const runner = new ScheduledWorkflowRunner(f.store, f.task, f.run, agent, {
    call: async (name, args, context) => {
      const data = await f.store.read()
      assert.ok(data.runs[0].entries.at(-1).text.includes(name), 'intent must be durable before execution')
      assert.equal(context.owner, 'scheduled-thread')
      calls.push(name)
      return name === 'read_tab' ? { text: calls.length === 1 ? 'unhealthy' : 'healthy' } : { sent: true, submitted: true }
    }, release: owner => released.push(owner), approval: () => {},
  })
  await runner.execute()
  const data = await f.store.read(), record = data.runs[0]
  assert.deepEqual(calls, ['read_tab', 'send_input', 'read_tab'])
  assert.equal(record.status, 'completed')
  assert.match(record.summary, /healthy/)
  assert.equal(record.threadId, 'scheduled-thread')
  assert.equal(record.turnId, 'turn-1')
  assert.ok(record.finishedAt)
  assert.ok(record.entries.some(e => e.kind === 'assistant' && e.text.includes('服务已恢复')))
  assert.ok(record.entries.some(e => e.kind === 'output' && e.text.includes('unhealthy')))
  assert.deepEqual(released, ['scheduled-thread'])
  assert.equal(agent.client.listenerCount('event'), 0)
})

test('workflow continues across turns until it explicitly records a verified conclusion', async t => {
  const f = await claim(t)
  let rounds = 0
  const agent = backend(async ({ ask, round }) => {
    rounds = round
    if (round === 1) await ask('read_tab', { tabId: 'fresh' })
    else await ask('scheduled_task_finish', { status: 'completed', evidence: 'second round verification' }, 'tabby_tasks')
  })
  await new ScheduledWorkflowRunner(f.store, f.task, f.run, agent, { call: async () => ({ text: 'working' }), release: () => {}, approval: () => {} }).execute()
  assert.equal(rounds, 2)
  assert.equal((await f.store.read()).runs[0].status, 'completed')
})

for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']) {
  test(`${method} is declined without publishing an interactive approval`, async t => {
    const f = await claim(t)
    const agent = backend(async ({ ask }) => {
      const response = await ask('', {}, '', method)
      assert.equal(response.decision, 'decline')
    })
    await new ScheduledWorkflowRunner(f.store, f.task, f.run, agent, {
      call: async () => assert.fail('no command should run'), release: () => {},
      approval: value => { if (value) assert.fail('unattended execution must not ask the user') },
    }).execute()
    const data = await f.store.read()
    assert.equal(data.runs[0].status, 'needs_attention')
    assert.equal(data.tasks[0].enabled, false)
    assert.ok(data.runs[0].entries.some(e => /无人值守.*拒绝/.test(e.text)))
  })
}

test('failed intent persistence stops before executing tools', async t => {
  const f = await claim(t)
  f.store.append = async () => { throw new Error('disk full') }
  const agent = backend(async ({ ask }) => { await ask('send_input', { text: 'must not execute', submit: true }) })
  await new ScheduledWorkflowRunner(f.store, f.task, f.run, agent, { call: async () => assert.fail('must persist before execute'), release: () => {}, approval: () => {} }).execute()
  const data = await f.store.read()
  assert.equal(data.runs[0].status, 'failed')
  assert.match(data.runs[0].summary, /disk full/)
})

test('workflow stops after eight unverified turns and preserves an unfinished status', async t => {
  const f = await claim(t)
  let rounds = 0
  const agent = backend(async ({ round }) => { rounds = round })
  await new ScheduledWorkflowRunner(f.store, f.task, f.run, agent, { call: async () => ({}), release: () => {}, approval: () => {} }).execute()
  const data = await f.store.read()
  assert.equal(rounds, 8)
  assert.equal(data.runs[0].status, 'needs_attention')
  assert.equal(data.tasks[0].enabled, false)
  assert.match(data.runs[0].summary, /8/)
})

test('execution records redact secrets in tool output', async t => {
  const f = await claim(t)
  await f.store.append(f.run.id, f.run.owner, 'output', 'Authorization: Bearer sk-abcdefghijklmnop\npassword=secret_value')
  const text = JSON.stringify((await f.store.read()).runs)
  assert.doesNotMatch(text, /abcdefghijklmnop|secret_value/)
  assert.match(text, /已隐藏/)
})

test('native and API tool definitions expose creation, management and execution completion', () => {
  assert.equal(SCHEDULE_TOOLS[0].name, 'tabby_tasks')
  assert.ok(SCHEDULE_TOOLS[0].tools.some(tool => tool.name === 'scheduled_task_create'))
  assert.ok(SCHEDULE_TOOLS[0].tools.some(tool => tool.name === 'scheduled_task_finish'))
})

test('explicit user stop cancels pending tool execution and records an interrupted run', async t => {
  const f = await claim(t)
  let entered
  const ready = new Promise(resolve => { entered = resolve })
  const agent = backend(async ({ ask }) => { await ask('read_tab', { tabId: 'fresh', waitMs: 10000 }) })
  const runner = new ScheduledWorkflowRunner(f.store, f.task, f.run, agent, {
    call: (_name, _args, context) => new Promise((resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      entered()
    }), release: () => {}, approval: () => {},
  })
  const done = runner.execute()
  await ready
  runner.stop()
  await done
  const data = await f.store.read()
  assert.equal(data.runs[0].status, 'interrupted')
  assert.equal(data.tasks[0].enabled, false)
  assert.match(data.runs[0].summary, /用户停止/)
})

test('user-input requests pause scheduled workflows with details rather than inventing answers', async t => {
  const f = await claim(t)
  const agent = backend(async ({ ask }) => { await ask('', {}, '', 'item/tool/requestUserInput') })
  await new ScheduledWorkflowRunner(f.store, f.task, f.run, agent, { call: async () => assert.fail('no tool needed'), release: () => {}, approval: () => {} }).execute()
  const data = await f.store.read()
  assert.equal(data.runs[0].status, 'needs_attention')
  assert.ok(data.runs[0].entries.some(entry => /requestUserInput/.test(entry.text)))
})

test('reported token usage enforces the configured budget across scheduled turns', async t => {
  const f = await claim(t)
  f.task.settings.goalTokenBudget = 100
  const agent = backend(async ({ event }) => { event('thread/tokenUsage/updated', { tokenUsage: { total: { totalTokens: 120 } } }) })
  await new ScheduledWorkflowRunner(f.store, f.task, f.run, agent, { call: async () => assert.fail('budget reached'), release: () => {}, approval: () => {} }).execute()
  const record = (await f.store.read()).runs[0]
  assert.equal(record.status, 'needs_attention')
  assert.equal(record.totalTokens, 120)
  assert.match(record.summary, /预算/)
})

test('one-shot triggers are consumed once, while manual runs preserve future scheduling', async t => {
  const { store } = await fixture(t)
  const now = Date.now()
  const task = await store.create({ ...args, scheduleType: 'at', at: new Date(now + 60000).toISOString() }, '/project', '', settings)
  const manual = await store.claim('owner', now, task.id, '/project')
  assert.equal((await store.read()).tasks[0].nextRunAt, now + 60000)
  await store.mutateRun(manual.run.id, 'owner', run => { run.status = 'completed'; run.finishedAt = Date.now() })
  assert.ok(await store.claim('owner', now + 60001))
  const data = await store.read()
  assert.equal(data.tasks[0].nextRunAt, null)
  assert.equal(data.tasks[0].enabled, false)
  assert.equal(await store.claim('other', now + 60002), undefined)
})

test('deletion is scoped, atomic against another window, and survives reopening the store', async t => {
  const f = await claim(t)
  const second = new ScheduledTaskStore(f.root)
  const other = await f.store.create(args, '/other', '', settings)
  await assert.rejects(second.remove(f.task.id, '/other'), /找不到/)
  await assert.rejects(second.remove(f.task.id, '/project'), /先停止/)
  assert.equal((await second.read()).tasks.length, 2)
  await f.store.mutateRun(f.run.id, f.run.owner, run => { run.status = 'completed'; run.finishedAt = Date.now() })
  await second.remove(f.task.id, '/project')
  const reopened = new ScheduledTaskStore(f.root)
  assert.deepEqual((await reopened.read()).tasks.map(t => t.id), [other.id])
  assert.equal((await reopened.read()).runs.length, 0)
  await assert.rejects(reopened.claim('new-window', Date.now(), f.task.id, '/project'), /找不到/)
})

for (const target of ['release', 'staging']) {
  test(`unattended questions research actual output and answer ${target} without a user`, async t => {
    const f = await claim(t)
    const questions = [{ id: 'branch', question: '应该测试哪个分支？', options: [{ label: 'main' }, { label: target }] }]
    const decisions = [], lookups = [], decisionSettings = []
    let closed = false
    const decision = backend(async ({ ask, event, text }) => {
      assert.match(text, /最优答案/)
      assert.match(text, /服务巡检/)
      const result = await ask('send_input', { tabId: 'shell', text: 'must not execute' })
      assert.equal(result.success, false)
      const state = output(await ask('read_tab', { tabId: 'shell' }))
      assert.equal(state.text, `target branch: ${target}`)
      event('thread/tokenUsage/updated', { tokenUsage: { total: { totalTokens: 9 } } })
      await ask('scheduled_task_finish', { status: 'completed', evidence: JSON.stringify({ answers: { branch: { answers: [target] } }, reason: `终端显示目标为 ${target}，符合任务要求` }) }, 'tabby_tasks')
    })
    decision.client.close = () => { closed = true }
    decision.connect = async settings => decisionSettings.push(settings)
    decision.openThread = async (_cwd, settings) => { decisionSettings.push(settings); return 'scheduled-thread' }
    const main = backend(async ({ ask, event }) => {
      event('thread/tokenUsage/updated', { tokenUsage: { total: { totalTokens: 10 } } })
      decisions.push(await ask('', {}, '', 'item/tool/requestUserInput', { questions }))
      event('thread/tokenUsage/updated', { tokenUsage: { total: { totalTokens: 20 } } })
      await ask('scheduled_task_finish', { status: 'completed', evidence: '已按自动选择继续并验证完成' }, 'tabby_tasks')
    })
    await new ScheduledWorkflowRunner(f.store, f.task, f.run, main, {
      decisionBackend: () => decision,
      call: async (name, args, context) => { assert.equal(context.readOnly, true); lookups.push(name); return { text: `target branch: ${target}` } },
      release: () => {}, approval: value => { if (value) assert.fail('no user approval') },
    }).execute()
    assert.equal(decisions[0].answers.branch.answers[0], target)
    assert.deepEqual(lookups, ['read_tab'])
    assert.ok(decisionSettings.every(s => s.sandbox === 'read-only' && s.approvalPolicy === 'never'))
    assert.equal(closed, true)
    assert.equal(decision.client.listenerCount('event'), 0)
    const data = await f.store.read()
    assert.equal(data.runs[0].status, 'completed')
    assert.equal(data.runs[0].totalTokens, 29)
    assert.ok(data.runs[0].entries.some(e => e.text.includes('自动回答') && e.text.includes(target)))
    assert.equal(f.task.settings.approvalPolicy, 'on-request', 'saved permissions remain unchanged')
  })
}

test('automatic decision cancellation closes its backend and pauses without dispatching answers', async t => {
  const f = await claim(t)
  const decision = backend(async () => new Promise(() => {}))
  let started
  const ready = new Promise(resolve => { started = resolve })
  const start = decision.startTurn
  decision.startTurn = async (...args) => { const id = await start(...args); started(); return id }
  let closed = false
  decision.client.close = () => { closed = true }
  const main = backend(async ({ ask }) => { await ask('', {}, '', 'item/tool/requestUserInput', { questions: [{ id: 'q', question: '目标？' }] }) })
  const runner = new ScheduledWorkflowRunner(f.store, f.task, f.run, main, { decisionBackend: () => decision, call: async () => assert.fail('no operation'), release: () => {}, approval: () => {} })
  const done = runner.execute()
  await ready
  runner.stop()
  await done
  assert.equal(closed, true)
  assert.equal((await f.store.read()).runs[0].status, 'interrupted')
})

for (const stage of ['connect', 'lookup']) {
  test(`stopping during automatic decision ${stage} cannot leave the scheduler waiting`, async t => {
    const f = await claim(t)
    let reached
    const ready = new Promise(resolve => { reached = resolve })
    const decision = backend(async ({ ask }) => { await ask('read_tab', { tabId: 'shell' }) })
    let closed = false
    decision.client.close = () => { closed = true }
    if (stage === 'connect') decision.connect = async () => { reached(); return new Promise(() => {}) }
    const main = backend(async ({ ask }) => { await ask('', {}, '', 'item/tool/requestUserInput', { questions: [{ id: 'q', question: '应该选择哪个分支？' }] }) })
    const runner = new ScheduledWorkflowRunner(f.store, f.task, f.run, main, {
      decisionBackend: () => decision,
      call: async () => { reached(); return new Promise(() => {}) }, release: () => {}, approval: () => {},
    })
    const done = runner.execute()
    await ready
    runner.stop()
    await done
    assert.equal(closed, true)
    assert.equal((await f.store.read()).runs[0].status, 'interrupted')
  })
}
