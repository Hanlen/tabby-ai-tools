const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const Module = require('node:module')
const ts = require('typescript')
const { Subject } = require('rxjs')

class FakeTab {
  constructor (title) { this.title = title; this.topmostParent = null; this.hostView = { rootNodes: [{ textContent: 'Settings content' }] } }
}
class FakeTerminal extends FakeTab {
  constructor (title, lines) {
    super(title)
    this.profile = { type: 'local' }
    this.sent = []
    this.children = []
    this.session = { open: true, output$: new Subject(), getChildProcesses: async () => this.children }
    this.sessionChanged$ = new Subject()
    this.frontend = { xterm: { buffer: { active: { length: lines.length, getLine: i => ({ translateToString: () => lines[i] }) } } } }
  }
  sendInput (value) { this.sent.push(value); if (value === '\x03') this.children = [] }
}
class FakeSplit extends FakeTab {
  constructor (tabs) { super('Split'); this.tabs = tabs; tabs.forEach(tab => { tab.topmostParent = this }) }
  getAllTabs () { return this.tabs }
  getFocusedTab () { return this.focused || this.tabs[0] }
  focus (tab) { this.focused = tab }
}

const originalLoad = Module._load
const originalTsLoader = require.extensions['.ts']
Module._load = function (request, parent, isMain) {
  if (request === '@angular/core') return { Injectable: () => target => target }
  if (request === 'tabby-core') return { SplitTabComponent: FakeSplit }
  if (request === 'tabby-terminal') return { BaseTerminalTabComponent: FakeTerminal }
  if (request === 'tabby-settings') return { SettingsTabComponent: FakeTab }
  return originalLoad.call(this, request, parent, isMain)
}
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, experimentalDecorators: true } }).outputText
  module._compile(output, filename)
}
const { TabbyTabToolsService, TAB_TOOLS } = require('../src/tab-tools.ts')
const { ScheduledTaskStore } = require('../src/scheduled-tasks.ts')
const { ScheduledWorkflowRunner } = require('../src/scheduled-workflow-runner.ts')
Module._load = originalLoad
require.extensions['.ts'] = originalTsLoader

test('Tabby tools list, read, select, and operate every open terminal pane', async () => {
  const first = new FakeTerminal('Local', ['first output', 'second output'])
  const second = new FakeTerminal('Remote', ['remote output'])
  const settings = new FakeTab('Settings')
  const button = { tagName: 'BUTTON', textContent: 'Save', getAttribute: () => null, click () { this.clicked = true } }
  settings.hostView.rootNodes = [{ textContent: 'Settings content', querySelectorAll: () => [button], matches: () => false }]
  const split = new FakeSplit([first, second])
  const tabsChanged$ = new Subject()
  const activeTabChange$ = new Subject()
  const app = { tabs: [split, settings], activeTab: split, tabsChanged$, activeTabChange$, selectTab (tab) { this.activeTab = tab } }
  const watched = new Set()
  const output = { watch: tab => watched.add(tab), unwatch: tab => watched.delete(tab), cursor: () => 0, readSince: () => ({ text: '', truncated: false }) }
  const tools = new TabbyTabToolsService(app, output)
  try {
    assert.deepEqual(watched, new Set([first, second]))
    const listed = await tools.call('list_tabs', {})
    assert.deepEqual(listed.map(tab => tab.title), ['Local', 'Remote', 'Settings'])
    assert.equal((await tools.call('read_tab', { tabId: listed[1].id })).text, 'remote output')
    const settingsView = await tools.call('read_tab', { tabId: listed[2].id })
    assert.equal(settingsView.text, 'Settings content')
    assert.equal(settingsView.controls[0].label, 'Save')
    await tools.call('interact_tab', { tabId: listed[2].id, controlId: settingsView.controls[0].id, action: 'click' })
    assert.equal(button.clicked, true)
    await tools.call('select_tab', { tabId: listed[1].id })
    assert.equal(split.focused, second)
    await tools.call('send_input', { tabId: listed[1].id, text: 'pwd', submit: true })
    assert.deepEqual(second.sent, ['pwd\r'])
    assert.equal(tools.controls$.value[0].tabId, listed[1].id)
    second.sendInput('user input')
    assert.deepEqual(second.sent, ['pwd\r'])
    tools.releaseOwner('legacy')
    second.sendInput('user input')
    assert.deepEqual(second.sent, ['pwd\r', 'user input'])
    await assert.rejects(tools.call('send_input', { tabId: listed[2].id, text: 'pwd' }), /not a terminal/)
    app.tabs = [settings]
    tabsChanged$.next()
    assert.equal(watched.size, 0)
    await assert.rejects(tools.call('read_tab', { tabId: listed[1].id }), /no longer open/)
  } finally { tools.ngOnDestroy() }
})

test('Codex dynamic tool definitions contain the Tabby operations', () => {
  assert.equal(TAB_TOOLS[0].name, 'tabby_tabs')
  const names = TAB_TOOLS[0].tools.map(tool => tool.name)
  for (const name of ['list_tabs', 'read_tab', 'select_tab', 'send_input', 'release_tab', 'interact_tab', 'get_capabilities', 'read_skill', 'open_profile', 'run_command', 'split_tab']) assert.ok(names.includes(name))
  assert.equal(names.length, new Set(names).size)
})

test('stopping an API turn while process detection is pending prevents a late terminal command', async () => {
  const terminal = new FakeTerminal('Local', [])
  let finishDetection
  terminal.session.getChildProcesses = () => new Promise(resolve => { finishDetection = resolve })
  const tools = new TabbyTabToolsService({ tabs: [terminal], activeTab: terminal, tabsChanged$: new Subject(), activeTabChange$: new Subject() },
    { watch: () => 0, unwatch: () => {}, cursor: () => 0, readSince: () => ({ text: '' }) })
  try {
    const tabId = (await tools.call('list_tabs', {}))[0].id
    const controller = new AbortController()
    const sending = tools.call('send_input', { tabId, text: 'pwd', submit: true }, { owner: 'api-session', signal: controller.signal })
    controller.abort()
    finishDetection([])
    await assert.rejects(sending, /stopped/)
    assert.deepEqual(terminal.sent, [])
    assert.deepEqual(tools.controls$.value, [])
  } finally { tools.ngOnDestroy() }
})

test('read_tab waits for fresh output and can be stopped without reading the terminal', async () => {
  const terminal = new FakeTerminal('Build', ['building'])
  const tools = new TabbyTabToolsService({ tabs: [terminal], activeTab: terminal, tabsChanged$: new Subject(), activeTabChange$: new Subject() },
    { watch: () => 0, unwatch: () => {}, cursor: () => 0, readSince: () => ({ text: '' }) })
  try {
    const tabId = (await tools.call('list_tabs', {}))[0].id
    const reading = tools.call('read_tab', { tabId, waitMs: 30 })
    terminal.frontend.xterm.buffer.active.getLine = () => ({ translateToString: () => 'build passed' })
    assert.equal((await reading).text, 'build passed')

    let read = false
    terminal.frontend.xterm.buffer.active.getLine = () => { read = true; return { translateToString: () => '' } }
    const controller = new AbortController()
    const stopped = tools.call('read_tab', { tabId, waitMs: 30000 }, { owner: 'api-session', signal: controller.signal })
    controller.abort()
    await assert.rejects(stopped, /stopped/)
    assert.equal(read, false)

    const closed = tools.call('read_tab', { tabId, waitMs: 30 })
    tools.app.tabs = []
    await assert.rejects(closed, /no longer open/)
  } finally { tools.ngOnDestroy() }
})

test('existing foreground process is preserved until the user approves interruption', async () => {
  const terminal = new FakeTerminal('Build', ['compiling'])
  terminal.children = [{ pid: 123, command: 'npm run build' }]
  const app = { tabs: [terminal], activeTab: terminal, tabsChanged$: new Subject(), activeTabChange$: new Subject() }
  const output = { watch: () => 0, unwatch: () => {}, cursor: () => 0, readSince: () => ({ text: '' }) }
  const tools = new TabbyTabToolsService(app, output)
  const context = { owner: 'thread-1', confirmTakeover: async () => 'cancel' }
  try {
    const tabId = (await tools.call('list_tabs', {}))[0].id
    const blocked = await tools.call('send_input', { tabId, text: 'pwd', submit: true }, context)
    assert.equal(blocked.blocked, true)
    assert.deepEqual(terminal.sent, [])
    const cancelled = await tools.call('send_input', { tabId, text: 'pwd', submit: true, foregroundTaskNeeded: false, purpose: 'Inspect directory' }, context)
    assert.equal(cancelled.cancelled, true)
    assert.deepEqual(terminal.sent, [])
    context.confirmTakeover = async () => 'interrupt'
    const sent = await tools.call('send_input', { tabId, text: 'pwd', submit: true, foregroundTaskNeeded: false }, context)
    assert.equal(sent.sent, true)
    assert.deepEqual(terminal.sent, ['\x03', 'pwd\r'])
    assert.equal(tools.getControl('thread-1').title, 'Build')
    await tools.call('release_tab', { tabId }, context)
    assert.equal(tools.getControl('thread-1'), undefined)
  } finally { tools.ngOnDestroy() }
})

test('unknown remote terminal state requires confirmation and releases after the turn', async () => {
  const terminal = new FakeTerminal('SSH', [])
  delete terminal.session.getChildProcesses
  const app = { tabs: [terminal], activeTab: terminal, tabsChanged$: new Subject(), activeTabChange$: new Subject() }
  const output = { watch: () => 0, unwatch: () => {}, cursor: () => 0, readSince: () => ({ text: '' }) }
  const tools = new TabbyTabToolsService(app, output)
  let takeover
  const context = { owner: 'thread-remote', confirmTakeover: async request => { takeover = request; return 'proceed' } }
  try {
    const tabId = (await tools.call('list_tabs', {}))[0].id
    const sent = await tools.call('send_input', { tabId, text: 'ls', submit: true, foregroundTaskNeeded: false, purpose: 'List files' }, context)
    assert.equal(takeover.unknown, true)
    assert.equal(sent.userInputLocked, true)
    terminal.sendInput('user input')
    assert.deepEqual(terminal.sent, ['ls\r'])
    await tools.call('send_input', { tabId, text: 'yes', submit: true, mode: 'stdin' }, context)
    assert.deepEqual(terminal.sent, ['ls\r', 'yes\r'])
    tools.releaseOwner('thread-remote')
    terminal.sendInput('user input')
    assert.deepEqual(terminal.sent, ['ls\r', 'yes\r', 'user input'])
  } finally { tools.ngOnDestroy() }
})

test('remote interruption waits for confirmation that the prompt returned', async () => {
  const terminal = new FakeTerminal('SSH', [])
  delete terminal.session.getChildProcesses
  const app = { tabs: [terminal], activeTab: terminal, tabsChanged$: new Subject(), activeTabChange$: new Subject() }
  const output = { watch: () => 0, unwatch: () => {}, cursor: () => 0, readSince: () => ({ text: '' }) }
  const tools = new TabbyTabToolsService(app, output)
  const phases = []
  try {
    const tabId = (await tools.call('list_tabs', {}))[0].id
    const result = await tools.call('send_input', { tabId, text: 'pwd', submit: true }, {
      owner: 'thread-remote', confirmTakeover: async request => {
        phases.push(!!request.verifyIdle)
        if (request.verifyIdle) {
          assert.deepEqual(terminal.sent, ['\x03'])
          return 'cancel'
        }
        return 'interrupt'
      },
    })
    assert.deepEqual(phases, [false, true])
    assert.equal(result.sent, false)
    assert.deepEqual(terminal.sent, ['\x03'])
  } finally { tools.ngOnDestroy() }
})

test('local command waits for shell completion even after its child process exits', async () => {
  const terminal = new FakeTerminal('Local', [])
  const app = { tabs: [terminal], activeTab: terminal, tabsChanged$: new Subject(), activeTabChange$: new Subject() }
  const output = { watch: () => 0, unwatch: () => {}, cursor: () => 0, readSince: () => ({ text: '' }) }
  const tools = new TabbyTabToolsService(app, output)
  try {
    const tabId = (await tools.call('list_tabs', {}))[0].id
    terminal.children = []
    await tools.call('send_input', { tabId, text: 'sleep 1', submit: true }, { owner: 'thread-1' })
    terminal.session.output$.next('\x1b]133;C\x07')
    terminal.children = [{ pid: 456, command: 'sleep 1' }]
    await new Promise(resolve => setTimeout(resolve, 550))
    assert.equal(tools.controls$.value.length, 1)
    terminal.children = []
    await new Promise(resolve => setTimeout(resolve, 1100))
    assert.equal(tools.controls$.value.length, 1, 'a childless shell builtin may still be waiting for input')
    await tools.call('send_input', { tabId, mode: 'stdin', text: 'answer', submit: true }, { owner: 'thread-1' })
    terminal.session.output$.next('\x1b]133;D;0\x07\x1b]133;A\x07')
    assert.equal(tools.controls$.value.length, 0)
    terminal.sendInput('user input')
    assert.deepEqual(terminal.sent, ['sleep 1\r', 'answer\r', 'user input'])
  } finally { tools.ngOnDestroy() }
})

function interactiveFixture () {
  const terminal = new FakeTerminal('Codex', ['Agent: press Shift+Left to choose a response'])
  terminal.children = [{ pid: 42, command: 'codex' }]
  const tools = new TabbyTabToolsService({ tabs: [terminal], tabsChanged$: new Subject(), activeTabChange$: new Subject() },
    { watch: () => 0, unwatch: () => {}, cursor: () => 0, readSince: () => ({ text: '' }) })
  return { terminal, tools, context: { owner: 'supervisor' } }
}

test('supervisor attaches a running agent, presses Shift+Left, answers and checks the resulting screen', async () => {
  const { terminal, tools, context } = interactiveFixture()
  let screen = 'Agent: press Shift+Left to choose a response'
  const originalSend = terminal.sendInput
  terminal.sendInput = function(value) {
    originalSend.call(this, value)
    if (value === '\x1b[1;2D') screen = 'Selected: use test database. Press Enter.'
    else if (value === '\r') screen = 'Question: which environment?'
    else if (value === 'staging\r') screen = 'Agent finished; verified using staging.'
    else assert.fail('unexpected input: ' + JSON.stringify(value))
  }
  terminal.frontend.xterm.buffer.active.getLine = () => ({ translateToString: () => screen })
  try {
    const tabId = (await tools.call('list_tabs', {}))[0].id
    assert.match((await tools.call('read_tab', { tabId, waitMs: 0 })).text, /Shift\+Left/)
    const attached = await tools.call('attach_process', { tabId, expectedProcess: 'codex', purpose: '按用户要求控制这个 Agent 完成测试环境任务' }, context)
    assert.equal(attached.attached, true)
    assert.deepEqual(terminal.sent, [], 'attaching must never interrupt or restart the agent')
    await tools.call('send_keys', { tabId, key: 'Left', shift: true }, context)
    assert.match((await tools.call('read_tab', { tabId, waitMs: 0 })).text, /Selected/)
    await tools.call('send_keys', { tabId, key: 'Enter' }, context)
    assert.match((await tools.call('read_tab', { tabId, waitMs: 0 })).text, /which environment/)
    await tools.call('send_input', { tabId, mode: 'stdin', text: 'staging', submit: true }, context)
    assert.match((await tools.call('read_tab', { tabId, waitMs: 0 })).text, /verified using staging/)
    assert.deepEqual(terminal.sent, ['\x1b[1;2D', '\r', 'staging\r'])
  } finally { tools.ngOnDestroy() }
})

test('interactive keys require ownership, writable policy and an unchanged live agent', async () => {
  const { terminal, tools, context } = interactiveFixture()
  try {
    const tabId = (await tools.call('list_tabs', {}))[0].id
    await assert.rejects(tools.call('send_keys', { tabId, key: 'Enter' }, context), /owned/)
    await assert.rejects(tools.call('attach_process', { tabId, expectedProcess: 'codex', purpose: 'supervise' }, { ...context, readOnly: true }), /只读|read.only/i)
    await tools.call('attach_process', { tabId, expectedProcess: 'codex', purpose: 'supervise' }, context)
    await assert.rejects(tools.call('send_keys', { tabId, key: 'Enter' }, { owner: 'other-task' }), /owned/)
    await assert.rejects(tools.call('send_keys', { tabId, key: 'Enter' }, { ...context, readOnly: true }), /只读|read.only/i)
    terminal.children = []
    await assert.rejects(tools.call('send_keys', { tabId, key: 'Enter' }, context), /exited/)
    assert.deepEqual(terminal.sent, [])
    assert.equal(tools.controls$.value.length, 0)
  } finally { tools.ngOnDestroy() }
})

test('attaching fails for an unverified process and cancelled process detection cannot claim ownership', async () => {
  const { terminal, tools, context } = interactiveFixture()
  try {
    const tabId = (await tools.call('list_tabs', {}))[0].id
    await assert.rejects(tools.call('attach_process', { tabId, expectedProcess: 'claude', purpose: 'supervise' }, context), /not running/)
    delete terminal.session.getChildProcesses
    await assert.rejects(tools.call('attach_process', { tabId, expectedProcess: 'codex', purpose: 'supervise' }, context), /Cannot verify/)
    let finish
    terminal.session.getChildProcesses = () => new Promise(resolve => { finish = resolve })
    const controller = new AbortController()
    const attaching = tools.call('attach_process', { tabId, expectedProcess: 'codex', purpose: 'supervise' }, { ...context, signal: controller.signal })
    controller.abort()
    finish([{ command: 'codex' }])
    await assert.rejects(attaching, /stopped/)
    assert.deepEqual(tools.controls$.value, [])
  } finally { tools.ngOnDestroy() }
})

test('scheduled supervisor operates an interactive agent through repeated prompts and logs keys and answers', async t => {
  const { EventEmitter } = require('node:events')
  const path = require('node:path'), os = require('node:os')
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tabby-supervised-agent-'))
  const { terminal, tools } = interactiveFixture()
  t.after(async () => { tools.ngOnDestroy(); await fs.promises.rm(root, { recursive: true, force: true }) })
  let screen = 'Codex: press Shift+Left to select the test environment'
  const originalSend = terminal.sendInput
  terminal.sendInput = function(value) {
    originalSend.call(this, value)
    if (value === '\x1b[1;2D') screen = 'Selected staging. Press Enter to confirm.'
    else if (value === '\r') screen = 'Codex asks: which branch should I test?'
    else if (value === 'release\r') screen = 'Codex completed: branch release tested successfully.'
    else assert.fail('Unexpected interactive input ' + JSON.stringify(value))
  }
  terminal.frontend.xterm.buffer.active.getLine = () => ({ translateToString: () => screen })
  const store = new ScheduledTaskStore(root)
  const settings = { executable: 'codex', model: '', reasoningEffort: '', approvalPolicy: 'never', sandbox: 'workspace-write', threads: {}, goalTokenBudget: 0 }
  const task = await store.create({ title: '控制 Codex 完成测试', instructions: '控制已运行的 codex，在 staging 测试 release 分支，回答过程中的常规问题并核对完成结果', scheduleType: 'interval', intervalMinutes: 5 }, '/project', '', settings)
  const { run } = await store.claim('window-owner', Date.now(), task.id, '/project')
  const client = new EventEmitter(), pending = new Map()
  let requestId = 0
  function ask(name, args, namespace = 'tabby_tabs') {
    const id = ++requestId
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      client.emit('event', { id, method: 'item/tool/call', params: { threadId: 'supervisor-thread', namespace, tool: name, arguments: args } })
    })
  }
  client.respond = (id, result) => { pending.get(id)?.resolve(result); pending.delete(id) }
  client.respondError = (id, message) => { pending.get(id)?.reject(new Error(message)); pending.delete(id) }
  const resultText = response => { assert.equal(response.success, true); return JSON.parse(response.contentItems[0].text) }
  const backend = { client, connect: async () => {}, openThread: async () => 'supervisor-thread', interrupt: async () => {}, startTurn: async () => {
    setImmediate(async () => {
      let error
      try {
        const [{ id: tabId }] = resultText(await ask('list_tabs', {}))
        assert.match(resultText(await ask('read_tab', { tabId, waitMs: 0 })).text, /Shift\+Left/)
        resultText(await ask('attach_process', { tabId, expectedProcess: 'codex', purpose: '控制 Codex 测试 staging 的 release 分支' }))
        resultText(await ask('send_keys', { tabId, key: 'Left', shift: true }))
        assert.match(resultText(await ask('read_tab', { tabId, waitMs: 0 })).text, /Selected staging/)
        resultText(await ask('send_keys', { tabId, key: 'Enter' }))
        assert.match(resultText(await ask('read_tab', { tabId, waitMs: 0 })).text, /which branch/)
        resultText(await ask('send_input', { tabId, mode: 'stdin', text: 'release', submit: true }))
        const final = resultText(await ask('read_tab', { tabId, waitMs: 0 })).text
        assert.match(final, /tested successfully/)
        resultText(await ask('scheduled_task_finish', { status: 'completed', evidence: final }, 'tabby_tasks'))
      } catch (caught) { error = { message: caught.message } }
      client.emit('event', { method: 'turn/completed', params: { threadId: 'supervisor-thread', turn: { id: 'turn', status: error ? 'failed' : 'completed', error } } })
    })
    return 'turn'
  } }
  await new ScheduledWorkflowRunner(store, task, run, backend, {
    call: (name, args, context) => tools.call(name, args, context), release: owner => tools.releaseOwner(owner), approval: () => {},
  }).execute()
  const record = (await store.read()).runs[0]
  assert.equal(record.status, 'completed', record.summary)
  assert.match(record.summary, /release tested successfully/)
  assert.ok(record.entries.some(entry => entry.kind === 'action' && /send_keys.*Left.*shift/.test(entry.text)))
  assert.ok(record.entries.some(entry => entry.kind === 'action' && /send_input.*release/.test(entry.text)))
  assert.ok(record.entries.some(entry => entry.kind === 'output' && /which branch/.test(entry.text)))
  assert.equal(tools.controls$.value.length, 0)
  assert.deepEqual(terminal.sent, ['\x1b[1;2D', '\r', 'release\r'])
})

function ownershipFixture (type = 'ssh') {
  const terminal = new FakeTerminal('Terminal', ['(END)'])
  terminal.profile.type = type
  terminal.frontend.xterm.buffer.active.type = 'normal'
  terminal.session.closed$ = new Subject()
  terminal.session.destroyed$ = new Subject()
  const app = { tabs: [terminal], tabsChanged$: new Subject(), activeTabChange$: new Subject() }
  const tools = new TabbyTabToolsService(app, { watch () {}, unwatch () {}, cursor: () => 0, readSince: () => ({ text: '' }) })
  const context = { owner: 'task', confirmTakeover: async request => { assert.equal(request.unknown, true); return 'proceed' } }
  return { terminal, app, tools, context }
}

test('SSH placeholder [] requires takeover confirmation and cannot auto-attach an unknown agent', async () => {
  const f = ownershipFixture()
  try {
    const tabId = (await f.tools.call('list_tabs', {}))[0].id
    assert.equal((await f.tools.call('read_tab', { tabId })).runningProcesses, null)
    await assert.rejects(f.tools.call('send_input', { tabId, text: 'pwd', submit: true }, { owner: 'task' }), /confirmation/)
    await assert.rejects(f.tools.call('attach_process', { tabId, expectedProcess: 'codex', purpose: 'inspect' }, f.context), /Cannot verify/)
    assert.deepEqual(f.terminal.sent, [])
  } finally { f.tools.ngOnDestroy() }
})

for (const type of ['ssh', 'local']) {
  test(`${type} pager stays owned across repeated empty process lists, accepts q and releases at shell completion`, async () => {
    const f = ownershipFixture(type)
    try {
      const tabId = (await f.tools.call('list_tabs', {}))[0].id
      const sent = await f.tools.call('send_input', { tabId, text: 'git log', submit: true }, f.context)
      assert.equal(sent.userInputLocked, true)
      // Local inspection sees a child once, then becomes empty while the pager is still open.
      const state = f.tools.controlled.get(f.terminal)
      state.observedProcess = true
      f.terminal.frontend.xterm.buffer.active.type = 'alternate'
      f.terminal.session.output$.next('\x1b]133;C\x07')
      await new Promise(resolve => setTimeout(resolve, 1200))
      assert.equal((await f.tools.call('read_tab', { tabId, waitMs: 0 })).controlledByAI, true)
      await assert.rejects(f.tools.call('send_keys', { tabId, key: 'Enter' }, { owner: 'other' }), /owned/)
      await f.tools.call('send_input', { tabId, mode: 'stdin', text: 'q', submit: false }, f.context)
      f.terminal.sendInput('blocked user input')
      assert.deepEqual(f.terminal.sent, ['git log\r', 'q'])
      // Leaving alternate screen is insufficient: the outer command may still be running.
      f.terminal.frontend.xterm.buffer.active.type = 'normal'
      f.terminal.session.output$.next('shell-like text $ \x1b]133;A\x07')
      assert.ok(f.tools.getControl('task'))
      f.terminal.session.output$.next('\x1b]133;D;0\x07\x1b]13')
      f.terminal.session.output$.next('3;A\x1b\\')
      assert.equal(f.tools.getControl('task'), undefined)
      f.terminal.sendInput('user input')
      assert.deepEqual(f.terminal.sent, ['git log\r', 'q', 'user input'])
      assert.equal(f.terminal.session.output$.observers.length, 0)
    } finally { f.tools.ngOnDestroy() }
  })
}

for (const type of ['ssh', 'local']) {
  test(`${type} long silent command is not declared finished by elapsed time or initially empty enumeration`, async () => {
    const f = ownershipFixture(type)
    try {
      const tabId = (await f.tools.call('list_tabs', {}))[0].id
      await f.tools.call('send_input', { tabId, text: 'sleep 3600', submit: true }, f.context)
      f.tools.controlled.get(f.terminal).startedAt -= 3600000
      await new Promise(resolve => setTimeout(resolve, 1200))
      assert.ok(f.tools.getControl('task'))
      await f.tools.call('send_keys', { tabId, key: 'c', ctrl: true }, f.context)
      assert.deepEqual(f.terminal.sent, ['sleep 3600\r', '\x03'])
      assert.equal((await f.tools.call('release_tab', { tabId }, f.context)).released, true)
      await assert.rejects(f.tools.call('send_input', { tabId, mode: 'stdin', text: 'q' }, f.context), /owned/)
    } finally { f.tools.ngOnDestroy() }
  })
}

for (const lifecycle of ['user-release', 'owner-release', 'closed', 'destroyed', 'replace-session', 'close-tab']) {
  test(`SSH lock restores input and removes listeners on ${lifecycle}`, async () => {
    const f = ownershipFixture()
    try {
      const tabId = (await f.tools.call('list_tabs', {}))[0].id
      await f.tools.call('send_input', { tabId, text: 'agent', submit: true }, f.context)
      const session = f.terminal.session
      if (lifecycle === 'user-release') assert.equal(f.tools.releaseTab('task', tabId), true)
      if (lifecycle === 'owner-release') f.tools.releaseOwner('task')
      if (lifecycle === 'closed') { session.open = false; session.closed$.next() }
      if (lifecycle === 'destroyed') session.destroyed$.next()
      if (lifecycle === 'replace-session') { f.terminal.session = { open: true }; f.terminal.sessionChanged$.next(f.terminal.session) }
      if (lifecycle === 'close-tab') { f.app.tabs = []; f.app.tabsChanged$.next() }
      assert.equal(f.tools.getControl('task'), undefined)
      assert.equal(session.output$.observers.length, 0)
      assert.equal(session.closed$.observers.length, 0)
      f.terminal.sendInput('user input')
      assert.deepEqual(f.terminal.sent, ['agent\r', 'user input'])
    } finally { f.tools.ngOnDestroy() }
  })
}

test('attached local process inspection failure blocks input without discarding its owner', async () => {
  const { terminal, tools, context } = interactiveFixture()
  try {
    const tabId = (await tools.call('list_tabs', {}))[0].id
    await tools.call('attach_process', { tabId, expectedProcess: 'codex', purpose: 'supervise' }, context)
    const inspect = terminal.session.getChildProcesses
    terminal.session.getChildProcesses = async () => { throw new Error('temporary inspection error') }
    await assert.rejects(tools.call('send_keys', { tabId, key: 'Enter' }, context), /unavailable/)
    assert.ok(tools.getControl(context.owner))
    terminal.session.getChildProcesses = inspect
    await tools.call('send_keys', { tabId, key: 'Enter' }, context)
    assert.deepEqual(terminal.sent, ['\r'])
  } finally { tools.ngOnDestroy() }
})

test('shell completion tolerates asynchronous alternate-screen rendering but not a partial command batch', async () => {
  const f = ownershipFixture()
  try {
    const tabId = (await f.tools.call('list_tabs', {}))[0].id
    await f.tools.call('send_input', { tabId, text: 'less file', submit: true }, f.context)
    f.terminal.frontend.xterm.buffer.active.type = 'alternate'
    f.terminal.session.output$.next('\x1b]133;C\x07\x1b]133;D;0\x07\x1b]133;A\x07')
    assert.ok(f.tools.getControl('task'))
    f.terminal.frontend.xterm.buffer.active.type = 'normal'
    await new Promise(resolve => setTimeout(resolve, 550))
    assert.equal(f.tools.getControl('task'), undefined)
    await f.tools.call('send_input', { tabId, text: 'echo first\nsleep 3600', submit: true }, f.context)
    f.terminal.session.output$.next('\x1b]133;C\x07first\r\n\x1b]133;D;0\x07\x1b]133;A\x07')
    await new Promise(resolve => setTimeout(resolve, 550))
    assert.ok(f.tools.getControl('task'), 'the first prompt in a multiline paste cannot release the batch')
    assert.equal((await f.tools.call('release_tab', { tabId }, f.context)).released, true)
  } finally { f.tools.ngOnDestroy() }
})

test('a pre-existing local alternate-screen process with empty enumeration still needs takeover confirmation', async () => {
  const f = ownershipFixture('local')
  try {
    const tabId = (await f.tools.call('list_tabs', {}))[0].id
    f.terminal.frontend.xterm.buffer.active.type = 'alternate'
    await assert.rejects(f.tools.call('send_input', { tabId, text: 'pwd', submit: true }, { owner: 'task' }), /confirmation/)
    assert.deepEqual(f.terminal.sent, [])
  } finally { f.tools.ngOnDestroy() }
})

test('verified local attachment releases after the owned process actually disappears', async () => {
  const { terminal, tools, context } = interactiveFixture()
  try {
    const tabId = (await tools.call('list_tabs', {}))[0].id
    await tools.call('attach_process', { tabId, expectedProcess: 'codex', purpose: 'supervise' }, context)
    terminal.children = []
    await new Promise(resolve => setTimeout(resolve, 1100))
    assert.equal(tools.getControl(context.owner), undefined)
    await assert.rejects(tools.call('send_keys', { tabId, key: 'Enter' }, context), /owned/)
  } finally { tools.ngOnDestroy() }
})
