const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const originalLoad = Module._load
const originalTsLoader = require.extensions['.ts']
Module._load = function (request, parent, isMain) {
  if (request === '@angular/core') return { Component: () => target => target, Input: () => () => {}, Output: () => () => {}, ViewChild: () => () => {}, EventEmitter: class {} }
  if (request === 'tabby-core') return { ConfigService: class {} }
  if (request === 'tabby-terminal') return { BaseTerminalTabComponent: class {} }
  if (['./codex.service', './terminal-output.service', './tab-tools', './agent-backend.service'].includes(request)) return {}
  if (request.endsWith('.pug') || request.endsWith('.css')) return ''
  return originalLoad.call(this, request, parent, isMain)
}
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, experimentalDecorators: true },
}).outputText, filename)
const { CodexPanelComponent } = require('../src/codex-panel.component.ts')
const { TaskMemory, TaskMemoryStore } = require('../src/task-memory.ts')
Module._load = originalLoad
require.extensions['.ts'] = originalTsLoader
const localServer = { type: 'local', profileId: 'local-shell', serverId: 'local-machine', host: 'workstation', ip: '127.0.0.1', port: 0, username: 'test', cwd: '/project' }
const flush = () => new Promise(resolve => setImmediate(resolve))

async function setup (t, api = false) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tabby-memory-panel-'))
  t.after(async () => { await library.store.writes; await fs.promises.rm(root, { force: true, recursive: true }) })
  const library = new TaskMemory(new TaskMemoryStore(root))
  const memory = { enabled: true, library, activeLibrary: library }
  const sent = [], tools = [], replies = [], goals = []
  let goalStatus = 'active'
  const profile = { id: 'deepseek', name: 'DeepSeek', model: 'fixture-model', threads: {} }
  const backend = { ...(api ? { profile } : {}), client: { respond: (...args) => replies.push(args) },
    setGoal: async (...args) => goals.push(args), startTurn: async (...args) => { sent.push(args); return 'turn-1' },
    getGoal: async () => ({ status: goalStatus }),
  }
  const agents = { memory, defaultProfileId: api ? profile.id : '', create: () => backend }
  const panel = new CodexPanelComponent({ store: { codexAgent: { apiProfiles: [profile], goalTokenBudget: 0 } } }, backend,
    { run: fn => fn() }, {}, { releaseOwner: () => {}, call: async (name, args) => {
      tools.push({ name, args })
      return name === 'send_input' ? { sent: true, submitted: true } : { title: 'project shell', server: localServer, text: 'build output' }
    } }, agents)
  Object.assign(panel, { loading: false, threadId: 'thread', cwd: '/project', connected: true })
  panel.ensureSource = async () => {}
  panel.readOutput = () => ({ message: 'current terminal data', cursor: 0, length: 0 })
  panel.scheduleOutputFlush = () => {}
  const tool = async (name, args) => {
    panel.handleEvent({ id: tools.length + 1, method: 'item/tool/call', params: { threadId: panel.threadId, namespace: 'tabby_tabs', tool: name, arguments: args } })
    await flush()
  }
  const finish = async () => {
    goalStatus = 'complete'
    const pending = []
    const originalFinish = library.finish.bind(library)
    library.finish = (...args) => { const promise = originalFinish(...args); pending.push(promise); return promise }
    panel.handleEvent({ method: 'turn/completed', params: { threadId: panel.threadId, turn: { id: 'turn-1', status: 'completed' } } })
    await flush()
    await Promise.all(pending)
    library.finish = originalFinish
    await flush()
  }
  return { panel, library, memory, sent, tools, replies, goals, tool, finish }
}

for (const api of [false, true]) {
  test(`${api ? 'API' : 'Codex'} panel records an explicit task and executes its alias`, async t => {
    const f = await setup(t, api)
    f.panel.prompt = '/remember 构建前端项目并核对结果'
    await f.panel.send()
    assert.equal(f.sent.length, 1)
    assert.equal(f.sent[0][1], '构建前端项目并核对结果')
    assert.match(f.sent[0][4], /current terminal data/)
    await f.tool('read_tab', { tabId: 'ephemeral' })
    await f.tool('send_input', { tabId: 'ephemeral', text: 'pnpm build', submit: true, purpose: '构建前端项目' })
    await f.tool('read_tab', { tabId: 'ephemeral' })
    await f.tool('workflow_checkpoint', { action: 'confirm_step', tabId: 'ephemeral', step: 1, criteria: '构建成功且产物存在', evidence: '本次构建退出成功，产物检查通过' })
    f.panel.entries.push({ kind: 'agent', text: '已核对构建产物' })
    await f.finish()
    const document = await f.library.store.read()
    assert.equal(document.workflows.length, 1)
    assert.ok(f.panel.pendingWorkflow)
    f.panel.workflowAlias = 'task1'
    await f.panel.saveWorkflowAlias()
    f.panel.threadId = 'next-thread'
    f.panel.prompt = '/task1'
    await f.panel.send()
    assert.equal(f.sent.length, 2)
    assert.equal(f.sent[1][1], '/task1')
    assert.match(f.sent[1][4], /pnpm build/)
    assert.match(f.sent[1][4], /current terminal data/)
    assert.doesNotMatch(f.sent[1][4], /ephemeral/)
    assert.equal(f.tools.length, 3, 'matching a workflow must never execute or replay a tool')
    assert.match(f.panel.memoryNotice, /参考流程/)
    assert.equal(f.goals[1][1], '/task1')
  })
}

test('ordinary requests and global disable send ordinary prompts and do not record partial workflows', async t => {
  const f = await setup(t)
  await f.library.addPreference('使用 pnpm', '')
  f.panel.prompt = 'build frontend'
  await f.panel.send()
  assert.match(f.sent[0][4], /pnpm/)
  assert.equal(f.library.token('thread'), undefined)
  f.panel.busy = false
  f.memory.enabled = false
  f.panel.prompt = 'another task'
  await f.panel.send()
  assert.equal(f.sent[1][4], 'current terminal data')
})

test('an unreadable memory store does not fail or duplicate a live task', async t => {
  const f = await setup(t)
  f.library.store.read = async () => { throw new Error('corrupt memory') }
  f.panel.prompt = 'build frontend'
  await f.panel.send()
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0][4], 'current terminal data')
  assert.match(f.panel.memoryNotice, /读取流程库失败/)
  assert.equal(f.panel.busy, true)
})

test('/remember starts execution rather than saving a preference; workflow picker fills an alias', async t => {
  const f = await setup(t)
  f.panel.prompt = '/remember build frontend'
  await f.panel.send()
  assert.equal((await f.library.store.read()).preferences.length, 0)
  assert.equal(f.sent.length, 1)
  assert.ok(f.library.token('thread'))
  f.panel.useWorkflow({ title: '前端构建', objective: '构建前端项目', alias: 'task1' })
  assert.equal(f.panel.prompt, '/task1')
  assert.equal(f.panel.workflowPanelOpen, false)
})

test('sudo aliases include authentication instructions and enable terminal preflight', async t => {
  const f = await setup(t)
  await f.library.store.update(data => data.workflows.push({ id: 'sudo-task', title: 'restart', objective: 'restart app', cwd: '/project', alias: 'restart', instructions: 'sudo systemctl restart app', steps: [], outcome: '', completedAt: 1, successes: 1, uses: 0, enabled: true, edited: true }))
  f.panel.prompt = '/restart'
  await f.panel.send()
  assert.match(f.sent[0][4], /sudo -v.*sudo ls/)
  assert.equal(f.panel.sudoWorkflow, true)
  assert.ok(f.library.token('thread'), 'alias execution has a checkpoint session')
})

for (const api of [false, true]) {
  test(`${api ? 'API' : 'Codex'} panel routes scheduling tools to the scheduler without executing terminal commands`, async t => {
    const f = await setup(t, api)
    const calls = []
    f.panel.agents.scheduler = { call: async (...args) => { calls.push(args); return { result: { id: 'saved-task' } } }, refresh: async () => {} }
    const args = { title: '每天巡检', instructions: '检查服务，按输出决定后续操作', scheduleType: 'daily', time: '09:00', timezone: 'Asia/Shanghai' }
    f.panel.handleEvent({ id: 45, method: 'item/tool/call', params: { threadId: 'thread', namespace: 'tabby_tasks', tool: 'scheduled_task_create', arguments: args } })
    await flush()
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].slice(0, 4), ['scheduled_task_create', args, '/project', api ? 'deepseek' : ''])
    assert.equal(f.tools.length, 0)
    assert.equal(f.replies[0][1].success, true)
    assert.match(f.replies[0][1].contentItems[0].text, /saved-task/)
    await f.panel.runSlashCommand('/schedules')
    assert.equal(f.panel.schedulePanelOpen, true)
    assert.equal(f.sent.length, 0)
  })
}

test('an early complete goal stays pending until workflow steps have actual checkpoints', async t => {
  const f = await setup(t)
  f.panel.prompt = '/remember restart database then application'
  await f.panel.send()
  await f.tool('read_tab', { tabId: 'db' })
  await f.tool('send_input', { tabId: 'db', text: 'restart database', submit: true })
  await f.tool('read_tab', { tabId: 'app' })
  await f.tool('send_input', { tabId: 'app', text: 'restart application', submit: true })
  assert.equal(f.tools.filter(call => call.name === 'send_input').length, 1, 'the dependent action never reaches the terminal tool')
  assert.equal(f.replies.at(-1)[1].success, false)
  await f.finish()
  assert.equal(f.panel.goalStatus, 'active')
  assert.match(f.panel.memoryNotice, /未经实际结果验收/)
  assert.equal((await f.library.store.read()).workflows.length, 0)
})

test('continuing a workflow supplies its checkpoint state again as hidden context', async t => {
  const f = await setup(t)
  f.panel.prompt = '/remember restart database then application'
  await f.panel.send()
  await f.tool('read_tab', { tabId: 'db' })
  await f.tool('send_input', { tabId: 'db', text: 'restart database', submit: true })
  f.panel.busy = false
  await f.panel.continueTask()
  assert.match(f.sent[1][4], /workflow_checkpoint/)
  assert.match(f.sent[1][4], /"pendingStep":\{"number":1,"runtimeTabId":"db"/)
  assert.match(f.sent[1][4], /restart database/)
})
