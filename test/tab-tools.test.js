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
const { CodexTerminalOutputService } = require('../src/terminal-output.service.ts')
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

function snapshotLatencyFixture (t) {
  const terminal = new FakeTerminal('Observe', ['ready'])
  let text = '', unmask
  const app = { tabs: [terminal], tabsChanged$: new Subject(), activeTabChange$: new Subject() }
  const output = new CodexTerminalOutputService(app)
  const tools = new TabbyTabToolsService(app, output)
  const controller = new AbortController(), context = { owner: 'observer', signal: controller.signal }
  t.after(() => { controller.abort(); tools.ngOnDestroy() })
  return { terminal, output, tools, context, controller,
    suppress (value) { if (value) unmask = output.suppress(terminal); else unmask?.() },
    emit (value) {
      text += value
      terminal.frontend.xterm.buffer.active.getLine = () => ({ translateToString: () => text })
      terminal.session.output$.next(value)
    },
  }
}

for (const beforeRead of [false, true]) test(`snapshot wakes on unread output without shell integration (already arrived: ${beforeRead})`, { timeout: 3000 }, async t => {
  const f = snapshotLatencyFixture(t)
  const tabId = (await f.tools.call('list_tabs', {}))[0].id
  await f.tools.call('send_input', { tabId, text: 'pwd', submit: true }, f.context)
  if (beforeRead) f.emit('/workspace')
  const pending = f.tools.call('read_tab', { tabId, waitMs: 10000 }, f.context)
  if (!beforeRead) setTimeout(() => f.emit('/workspace'), 20)
  const view = await pending
  assert.equal(view.text, '/workspace')
  assert.equal(view.wakeReason, 'output')
  assert.ok(view.waitedMs < 1000)
  assert.equal(view.commandState, 'unknown')
  assert.equal(view.controlledByAI, true, 'output is not completion and must not release ownership')
  const quiet = await f.tools.call('read_tab', { tabId, waitMs: 100 }, f.context)
  assert.equal(quiet.wakeReason, 'timeout', 'already observed output cannot repeatedly wake a read')
  assert.ok(quiet.waitedMs >= 80)
  assert.equal(f.output.updates$.observers.length, 0)
  assert.deepEqual(f.terminal.sent, ['pwd\r'], 'observing never replays input')
})

test('multiline output returns promptly while retaining the batch lock after intermediate prompts', { timeout: 3000 }, async t => {
  const f = snapshotLatencyFixture(t)
  const tabId = (await f.tools.call('list_tabs', {}))[0].id
  await f.tools.call('send_input', { tabId, text: 'echo first\nsleep 3600', submit: true }, f.context)
  const pending = f.tools.call('read_tab', { tabId, waitMs: 10000 }, f.context)
  setTimeout(() => f.emit('\x1b]133;C\x07first\x1b]133;D;0\x07\x1b]133;A\x07'), 20)
  const view = await pending
  assert.equal(view.wakeReason, 'output')
  assert.ok(view.waitedMs < 1000)
  assert.equal(view.controlledByAI, true)
  assert.equal((await f.tools.call('send_input', { tabId, text: 'do not run', submit: true }, f.context)).blocked, true)
  assert.deepEqual(f.terminal.sent, ['echo first\nsleep 3600\r'])
})

test('continuous output has a bounded snapshot render delay', { timeout: 3000 }, async t => {
  const f = snapshotLatencyFixture(t)
  const tabId = (await f.tools.call('list_tabs', {}))[0].id
  await f.tools.call('send_input', { tabId, text: 'tail -f log', submit: true }, f.context)
  const pending = f.tools.call('read_tab', { tabId, waitMs: 10000 }, f.context)
  const timer = setInterval(() => f.emit('line\n'), 10)
  t.after(() => clearInterval(timer))
  const view = await pending
  clearInterval(timer)
  assert.equal(view.wakeReason, 'output')
  assert.ok(view.waitedMs < 800, 'continuous output must not indefinitely postpone the read')
  assert.equal(view.controlledByAI, true)
})

test('snapshot observation remains isolated by owner and rearms after stdin', { timeout: 3000 }, async t => {
  const f = snapshotLatencyFixture(t)
  const tabId = (await f.tools.call('list_tabs', {}))[0].id
  await f.tools.call('send_input', { tabId, text: 'read answer', submit: true }, f.context)
  f.emit('Question?')
  const other = await f.tools.call('read_tab', { tabId, waitMs: 20 }, { owner: 'other' })
  assert.equal(other.wakeReason, 'timeout', 'another observer must not inherit pending input output')
  const own = await f.tools.call('read_tab', { tabId, waitMs: 10000 }, f.context)
  assert.equal(own.wakeReason, 'output', 'another observer must not consume the owner baseline')
  await f.tools.call('send_input', { tabId, text: 'answer', mode: 'stdin', submit: true }, f.context)
  const quiet = await f.tools.call('read_tab', { tabId, waitMs: 20 }, f.context)
  assert.equal(quiet.wakeReason, 'timeout', 'a previous prompt cannot wake the next interaction')
  f.emit('Accepted')
  const next = await f.tools.call('read_tab', { tabId, waitMs: 10000 }, f.context)
  assert.equal(next.wakeReason, 'output')
  assert.deepEqual(f.terminal.sent, ['read answer\r', 'answer\r'])
})

test('private output cannot wake default snapshots and cancellation removes listeners', { timeout: 3000 }, async t => {
  const f = snapshotLatencyFixture(t)
  const tabId = (await f.tools.call('list_tabs', {}))[0].id
  await f.tools.call('send_input', { tabId, text: 'pwd', submit: true }, f.context)
  f.suppress(true)
  f.emit('private payload')
  const view = await f.tools.call('read_tab', { tabId, waitMs: 30 }, f.context)
  assert.equal(view.text.includes('private payload'), false)
  assert.equal(view.wakeReason, 'timeout')
  f.suppress(false)
  await f.tools.call('read_tab', { tabId, waitMs: 0 }, f.context)
  const controls = f.tools.controls$.observers.length, lifecycle = f.output.lifecycle$.observers.length
  const pending = f.tools.call('read_tab', { tabId, waitMs: 10000 }, f.context)
  f.controller.abort()
  await assert.rejects(pending, /stopped/)
  assert.equal(f.output.updates$.observers.length, 0)
  assert.equal(f.output.lifecycle$.observers.length, lifecycle)
  assert.equal(f.tools.controls$.observers.length, controls)
  assert.deepEqual(f.terminal.sent, ['pwd\r'])
})

test('snapshot reads cwd and process metadata concurrently', async t => {
  const f = snapshotLatencyFixture(t)
  const tabId = (await f.tools.call('list_tabs', {}))[0].id
  let finishCwd, finishProcesses
  f.terminal.session.getWorkingDirectory = () => new Promise(resolve => { finishCwd = resolve })
  f.terminal.session.getChildProcesses = () => new Promise(resolve => { finishProcesses = resolve })
  const pending = f.tools.call('read_tab', { tabId, waitMs: 0 }, f.context)
  try {
    assert.equal(typeof finishCwd, 'function')
    assert.equal(typeof finishProcesses, 'function', 'process inspection must start before cwd resolves')
  } finally { finishCwd?.('/workspace'); finishProcesses?.([]) }
  assert.equal((await pending).server.cwd, '/workspace')
})

test('a failed snapshot does not consume unread output', { timeout: 3000 }, async t => {
  const f = snapshotLatencyFixture(t)
  const tabId = (await f.tools.call('list_tabs', {}))[0].id
  await f.tools.call('send_input', { tabId, text: 'pwd', submit: true }, f.context)
  f.emit('workspace')
  const buffer = f.terminal.frontend.xterm.buffer.active, readLine = buffer.getLine
  buffer.getLine = () => { throw new Error('renderer temporarily unavailable') }
  await assert.rejects(f.tools.call('read_tab', { tabId, waitMs: 0 }, f.context), /temporarily unavailable/)
  buffer.getLine = readLine
  const recovered = await f.tools.call('read_tab', { tabId, waitMs: 10000 }, f.context)
  assert.equal(recovered.wakeReason, 'output')
  assert.equal(recovered.text, 'workspace')
  assert.deepEqual(f.terminal.sent, ['pwd\r'])
})

test('overlapping snapshots never move the observation baseline backwards', { timeout: 3000 }, async t => {
  const f = snapshotLatencyFixture(t)
  const tabId = (await f.tools.call('list_tabs', {}))[0].id
  await f.tools.call('send_input', { tabId, text: 'tail -f log', submit: true }, f.context)
  f.emit('first')
  let finishCwd
  f.terminal.session.getWorkingDirectory = () => new Promise(resolve => { finishCwd = resolve })
  const slow = f.tools.call('read_tab', { tabId, waitMs: 0 }, f.context)
  f.emit('second')
  f.terminal.session.getWorkingDirectory = async () => '/workspace'
  await f.tools.call('read_tab', { tabId, waitMs: 0 }, f.context)
  finishCwd('/workspace')
  await slow
  assert.equal((await f.tools.call('read_tab', { tabId, waitMs: 20 }, f.context)).wakeReason, 'timeout')
})

test('changing terminal sessions stops snapshot waits and discards old observation baselines', { timeout: 3000 }, async t => {
  const f = snapshotLatencyFixture(t)
  const tabId = (await f.tools.call('list_tabs', {}))[0].id
  await f.tools.call('send_input', { tabId, text: 'pwd', submit: true }, f.context)
  const pending = f.tools.call('read_tab', { tabId, waitMs: 10000 }, f.context)
  f.terminal.session = { open: true, output$: new Subject(), getChildProcesses: async () => [] }
  f.terminal.sessionChanged$.next(f.terminal.session)
  const view = await pending
  assert.equal(view.wakeReason, 'session_changed')
  assert.equal(view.controlledByAI, false)
  assert.equal(view.commandState, 'unknown')
  assert.equal(f.output.updates$.observers.length, 0)
  assert.deepEqual(f.terminal.sent, ['pwd\r'])
})

test('terminal transport sends a 10000-character command intact and rejects larger input before writing', async () => {
  const terminal = new FakeTerminal('Install', [])
  const app = { tabs: [terminal], activeTab: terminal, tabsChanged$: new Subject(), activeTabChange$: new Subject() }
  const output = { watch () {}, unwatch () {}, cursor: () => 0, readSince: () => ({ text: '', truncated: false }) }
  const tools = new TabbyTabToolsService(app, output)
  try {
    const [{ id: tabId }] = await tools.call('list_tabs', {})
    const command = 'install-app ' + 'x'.repeat(10000 - 'install-app '.length)
    assert.equal((await tools.call('send_input', { tabId, text: command, submit: true })).submitted, true)
    assert.deepEqual(terminal.sent, [command + '\r'])
    await assert.rejects(tools.call('send_input', { tabId, text: command + 'x', submit: true }), /10,000/)
    assert.deepEqual(terminal.sent, [command + '\r'])
  } finally { tools.ngOnDestroy() }
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

for (const finishBeforeRead of [false, true]) test(`read_tab returns early on reliable completion (already finished: ${finishBeforeRead})`, { timeout: 4000 }, async t => {
  const terminal = new FakeTerminal('Local', ['working'])
  const tools = new TabbyTabToolsService({ tabs: [terminal], tabsChanged$: new Subject(), activeTabChange$: new Subject() },
    { watch: () => 0, unwatch: () => {}, cursor: () => 0, readSince: () => ({ text: '' }) })
  const controller = new AbortController()
  t.after(() => { controller.abort(); tools.ngOnDestroy() })
  const tabId = (await tools.call('list_tabs', {}))[0].id
  await tools.call('send_input', { tabId, text: 'pwd', submit: true }, { owner: 'task' })
  terminal.session.output$.next('\x1b]133;C\x07')
  const finish = () => {
    terminal.session.output$.next('\x1b]133;D;0\x07\x1b]133;A\x07')
    // Simulate xterm consuming a queued final write after the completion notification.
    setTimeout(() => { terminal.frontend.xterm.buffer.active.getLine = () => ({ translateToString: () => '/workspace' }) }, 0)
  }
  if (finishBeforeRead) finish()
  const started = Date.now()
  const result = tools.call('read_tab', { tabId, waitMs: 30000 }, { signal: controller.signal })
  if (!finishBeforeRead) setTimeout(finish, 10)
  const view = await result
  assert.ok(Date.now() - started < 2000, 'must not wait out the 30-second timeout')
  assert.equal(view.text, '/workspace')
  assert.equal(view.commandState, 'prompt')
  assert.equal(view.controlledByAI, false)
  assert.equal(tools.controls$.observers.length, 0, 'completion subscription is removed')
})

test('new commands, unknown output and multiline prompts do not reuse an old completion', async t => {
  const terminal = new FakeTerminal('Local', ['output'])
  const tools = new TabbyTabToolsService({ tabs: [terminal], tabsChanged$: new Subject(), activeTabChange$: new Subject() },
    { watch: () => 0, unwatch: () => {}, cursor: () => 0, readSince: () => ({ text: '' }) })
  const controller = new AbortController()
  t.after(() => { controller.abort(); tools.ngOnDestroy() })
  const tabId = (await tools.call('list_tabs', {}))[0].id
  await tools.call('send_input', { tabId, text: 'pwd', submit: true }, { owner: 'task' })
  terminal.session.output$.next('\x1b]133;C\x07\x1b]133;D;0\x07\x1b]133;A\x07')
  // A subsequent manually started command invalidates the earlier completion, including split OSC.
  terminal.session.output$.next('\x1b]133;')
  terminal.session.output$.next('C\x07')
  let resolved = false
  const reading = tools.call('read_tab', { tabId, waitMs: 30000 }, { signal: controller.signal }).then(() => { resolved = true })
  terminal.session.output$.next('some output\n$ looks like a prompt')
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(resolved, false)
  controller.abort()
  await assert.rejects(reading, /stopped/)
  assert.equal(tools.controls$.observers.length, 0)

  await tools.call('send_input', { tabId, text: 'pwd\nsleep 10', submit: true }, { owner: 'task' })
  terminal.session.output$.next('\x1b]133;C\x07\x1b]133;D;0\x07\x1b]133;A\x07')
  const multiline = new AbortController()
  const waiting = tools.call('read_tab', { tabId, waitMs: 30000 }, { signal: multiline.signal })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(tools.controls$.observers.length, 1, 'an intermediate prompt must not complete the batch')
  multiline.abort()
  await assert.rejects(waiting, /stopped/)
})

test('existing foreground process is preserved when needed and unrelated tasks are interrupted automatically', async () => {
  const terminal = new FakeTerminal('Build', ['compiling'])
  terminal.children = [{ pid: 123, command: 'npm run build' }]
  const app = { tabs: [terminal], activeTab: terminal, tabsChanged$: new Subject(), activeTabChange$: new Subject() }
  const output = { watch: () => 0, unwatch: () => {}, cursor: () => 0, readSince: () => ({ text: '' }) }
  const tools = new TabbyTabToolsService(app, output)
  const context = { owner: 'thread-1' }
  try {
    const tabId = (await tools.call('list_tabs', {}))[0].id
    const blocked = await tools.call('send_input', { tabId, text: 'pwd', submit: true }, context)
    assert.equal(blocked.blocked, true)
    assert.deepEqual(terminal.sent, [])
    const needed = await tools.call('send_input', { tabId, text: 'pwd', submit: true, foregroundTaskNeeded: true }, context)
    assert.equal(needed.blocked, true)
    assert.deepEqual(terminal.sent, [])
    const sent = await tools.call('send_input', { tabId, text: 'pwd', submit: true, foregroundTaskNeeded: false }, context)
    assert.equal(sent.sent, true)
    assert.deepEqual(terminal.sent, ['\x03', 'pwd\r'])
    assert.equal(tools.getControl('thread-1').title, 'Build')
    await tools.call('release_tab', { tabId }, context)
    assert.equal(tools.getControl('thread-1'), undefined)
  } finally { tools.ngOnDestroy() }
})

test('unknown remote terminal state takes over automatically and releases after the turn', async () => {
  const terminal = new FakeTerminal('SSH', [])
  delete terminal.session.getChildProcesses
  const app = { tabs: [terminal], activeTab: terminal, tabsChanged$: new Subject(), activeTabChange$: new Subject() }
  const output = { watch: () => 0, unwatch: () => {}, cursor: () => 0, readSince: () => ({ text: '' }) }
  const tools = new TabbyTabToolsService(app, output)
  const context = { owner: 'thread-remote' }
  try {
    const tabId = (await tools.call('list_tabs', {}))[0].id
    const sent = await tools.call('send_input', { tabId, text: 'ls', submit: true, foregroundTaskNeeded: false, purpose: 'List files' }, context)
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

test('stopping during automatic interruption prevents a late command', async () => {
  const terminal = new FakeTerminal('Build', [])
  terminal.children = [{ pid: 123, command: 'build' }]
  const tools = new TabbyTabToolsService({ tabs: [terminal], tabsChanged$: new Subject(), activeTabChange$: new Subject() },
    { watch () {}, unwatch () {}, cursor: () => 0 })
  try {
    const [{ id: tabId }] = await tools.call('list_tabs', {})
    const controller = new AbortController()
    const originalSend = terminal.sendInput.bind(terminal)
    terminal.sendInput = value => { originalSend(value); controller.abort() }
    await assert.rejects(tools.call('send_input', { tabId, text: 'pwd', submit: true, foregroundTaskNeeded: false }, {
      owner: 'task', signal: controller.signal,
    }), /stopped/)
    assert.deepEqual(terminal.sent, ['\x03'])
    assert.deepEqual(tools.controls$.value, [])
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
  const context = { owner: 'task' }
  return { terminal, app, tools, context }
}

test('SSH placeholder [] allows commands without confirmation and cannot auto-attach an unknown agent', async () => {
  const f = ownershipFixture()
  try {
    const tabId = (await f.tools.call('list_tabs', {}))[0].id
    assert.equal((await f.tools.call('read_tab', { tabId })).runningProcesses, null)
    await assert.rejects(f.tools.call('attach_process', { tabId, expectedProcess: 'codex', purpose: 'inspect' }, f.context), /Cannot verify/)
    assert.equal((await f.tools.call('send_input', { tabId, text: 'pwd', submit: true }, { owner: 'task' })).sent, true)
    assert.deepEqual(f.terminal.sent, ['pwd\r'])
  } finally { f.tools.ngOnDestroy() }
})

for (const type of ['ssh', 'local']) {
  test(`${type} pager stays owned across repeated empty process lists, accepts q and releases at shell completion`, async () => {
    const f = ownershipFixture(type)
    const outputWatchers = f.terminal.session.output$.observers.length
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
      assert.equal(f.terminal.session.output$.observers.length, outputWatchers, 'only the terminal completion monitor remains')
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
    const outputWatchers = f.terminal.session.output$.observers.length
    const lifecycleWatchers = f.terminal.session.closed$.observers.length
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
      const monitoring = ['user-release', 'owner-release'].includes(lifecycle)
      assert.equal(session.output$.observers.length, monitoring ? outputWatchers : 0)
      assert.equal(session.closed$.observers.length, monitoring ? lifecycleWatchers : 0)
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

test('unknown local enumeration does not require takeover confirmation or send Ctrl+C', async () => {
  const f = ownershipFixture('local')
  try {
    const tabId = (await f.tools.call('list_tabs', {}))[0].id
    f.terminal.frontend.xterm.buffer.active.type = 'alternate'
    assert.equal((await f.tools.call('send_input', { tabId, text: 'pwd', submit: true }, { owner: 'task' })).sent, true)
    assert.deepEqual(f.terminal.sent, ['pwd\r'])
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

test('sudo workflow preflight is injected into its target terminal and cleaned up on task release', async () => {
  const tab = new FakeTerminal('Local', [])
  const app = { tabs: [tab], tabsChanged$: new Subject(), activeTabChange$: new Subject() }
  const output = { watch () {}, unwatch () {}, cursor: () => 0 }
  const tools = new TabbyTabToolsService(app, output)
  try {
    const [{ id }] = await tools.call('list_tabs', {})
    await tools.call('send_input', { tabId: id, text: 'sudo ls', submit: true }, { owner: 'sudo-task', sudoLease: true })
    assert.match(tab.sent[0], /if sudo -n -v; then/)
    assert.match(tab.sent[0], /sudo ls/)
    assert.match(tab.sent[0], /sleep 30/)
    tab.session.output$.next('\x1b]133;C\x07\x1b]133;D;0\x07\x1b]133;A\x07')
    tools.releaseOwner('sudo-task')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(tab.sent.length, 2)
    assert.match(tab.sent[1], /unset __tabby_sudo_/)
  } finally { tools.ngOnDestroy() }
})

test('sudo cleanup waits for a remote shell prompt and never enters a foreground process', async () => {
  const tab = new FakeTerminal('Remote', [])
  tab.profile.type = 'ssh'
  const app = { tabs: [tab], tabsChanged$: new Subject(), activeTabChange$: new Subject() }
  const tools = new TabbyTabToolsService(app, { watch () {}, unwatch () {}, cursor: () => 0 })
  try {
    const [{ id }] = await tools.call('list_tabs', {})
    await tools.call('send_input', { tabId: id, text: 'sudo ls', submit: true }, { owner: 'sudo-task', sudoLease: true })
    tools.releaseOwner('sudo-task')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(tab.sent.length, 1)
    tab.session.output$.next('still running')
    assert.equal(tab.sent.length, 1)
    tab.session.output$.next('\x1b]133;A\x07')
    assert.equal(tab.sent.length, 1, 'a bare prompt is insufficient')
    tab.session.output$.next('\x1b]133;C\x07\x1b]133;D;0\x07\x1b]133;A\x07')
    assert.equal(tab.sent.length, 2)
    assert.match(tab.sent[1], /unset __tabby_sudo_/)
  } finally { tools.ngOnDestroy() }
})

test('terminal identity exposes stable connection IDs, IP and actual cwd without profile credentials', async () => {
  const tab = new FakeTerminal('Renamed terminal', [])
  tab.profile = { type: 'ssh', id: 'ssh-production', options: { host: '10.20.0.9', port: 2222, user: 'deploy', password: 'DO_NOT_EXPOSE', privateKey: 'PRIVATE_KEY_DATA', jumpHost: { password: 'NESTED_SECRET' } } }
  tab.session.getWorkingDirectory = async () => '/srv/application'
  const tools = new TabbyTabToolsService({ tabs: [tab], tabsChanged$: new Subject(), activeTabChange$: new Subject() }, { watch () {}, unwatch () {}, cursor: () => 0 })
  try {
    const [{ id }] = await tools.call('list_tabs', {})
    const result = await tools.call('read_tab', { tabId: id, waitMs: 0 })
    assert.deepEqual(result.server, { type: 'ssh', profileId: 'ssh-production', serverId: 'ssh-production', host: '10.20.0.9', ip: '10.20.0.9', port: 2222, username: 'deploy', cwd: '/srv/application' })
    assert.doesNotMatch(JSON.stringify(result.server), /DO_NOT_EXPOSE|PRIVATE_KEY_DATA|NESTED_SECRET/)
    tab.profile.options.host = 'app.internal'
    tab.session.getWorkingDirectory = async () => '/srv/new-directory'
    const changed = await tools.call('read_tab', { tabId: id, waitMs: 0 })
    assert.equal(changed.server.ip, '', 'a configured hostname is not an observed IP')
    assert.equal(changed.server.cwd, '/srv/new-directory')
    assert.notEqual(changed.server.serverId, id, 'pane IDs are not stable server IDs')
  } finally { tools.ngOnDestroy() }
})

test('delta waits for output, paginates without repeats, rejects stale and cross-owner cursors', async () => {
  const terminal = new FakeTerminal('Stream', [])
  let text = '', stream = 's1'
  const output = {
    watch: () => 0, unwatch: () => {}, streamId: () => stream, cursor: () => text.length,
    updates$: new Subject(), lifecycle$: new Subject(), isSuppressed: () => false,
    readSince: (_tab, cursor, max) => ({ text: text.slice(cursor, cursor + max), cursor: Math.min(text.length, cursor + max), hasMore: cursor + max < text.length, truncated: false }),
  }
  const tools = new TabbyTabToolsService({ tabs: [terminal], tabsChanged$: new Subject(), activeTabChange$: new Subject() }, output)
  try {
    const tabId = (await tools.call('list_tabs', {}))[0].id, context = { owner: 'a' }
    const baseline = await tools.call('read_tab', { tabId, mode: 'delta' }, context)
    const waiting = tools.call('read_tab', { tabId, mode: 'delta', cursor: baseline.nextCursor, waitMs: 10000, maxChars: 2 }, context)
    text = 'abcd'; output.updates$.next(terminal)
    const first = await waiting
    assert.equal(first.text, 'ab'); assert.equal(first.wakeReason, 'output'); assert.equal(first.hasMore, true)
    const second = await tools.call('read_tab', { tabId, mode: 'delta', cursor: first.nextCursor, maxChars: 2 }, context)
    assert.equal(second.text, 'cd')
    await assert.rejects(tools.call('read_tab', { tabId, mode: 'delta', cursor: first.nextCursor }, { owner: 'b' }), /unavailable/)
    stream = 's2'
    await assert.rejects(tools.call('read_tab', { tabId, mode: 'delta', cursor: first.nextCursor }, context), /session_changed/)
    assert.equal(output.updates$.observers.length, 0)
  } finally { tools.ngOnDestroy() }
})

test('delta cancellation cleans all wait listeners and sends no input', async () => {
  const terminal = new FakeTerminal('Quiet', [])
  const output = { watch: () => 0, unwatch: () => {}, streamId: () => 's', cursor: () => 0, updates$: new Subject(), lifecycle$: new Subject(), isSuppressed: () => false, readSince: () => ({ text: '', cursor: 0, hasMore: false, truncated: false }) }
  const tools = new TabbyTabToolsService({ tabs: [terminal], tabsChanged$: new Subject(), activeTabChange$: new Subject() }, output)
  try {
    const tabId = (await tools.call('list_tabs', {}))[0].id, controller = new AbortController(), context = { owner: 'a', signal: controller.signal }
    const base = await tools.call('read_tab', { tabId, mode: 'delta' }, context)
    const waiting = tools.call('read_tab', { tabId, mode: 'delta', cursor: base.nextCursor, waitMs: 10000 }, context)
    controller.abort()
    await assert.rejects(waiting, /stopped/)
    assert.equal(output.updates$.observers.length, 0)
    assert.equal(output.lifecycle$.observers.length, 1) // the service retains its own lifecycle subscription
    assert.deepEqual(terminal.sent, [])
  } finally { tools.ngOnDestroy() }
})

test('task logs persist only scoped captured output and remain readable after owner release', async t => {
  const os = require('node:os'), path = require('node:path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-log-tools-'))
  const terminal = new FakeTerminal('Task', [])
  let text = ''
  const output = { watch: () => 0, unwatch: () => {}, streamId: () => 's', cursor: () => text.length, chunks$: new Subject(), updates$: new Subject(), lifecycle$: new Subject(), isSuppressed: () => false, readSince: (_tab, cursor, max) => ({ text: text.slice(cursor, cursor + max), cursor: Math.min(text.length, cursor + max), hasMore: cursor + max < text.length, truncated: false }) }
  const tools = new TabbyTabToolsService({ tabs: [terminal], tabsChanged$: new Subject(), activeTabChange$: new Subject() }, output, undefined, undefined, { getConfigPath: () => path.join(root, 'config.yaml') })
  t.after(async () => { tools.ngOnDestroy(); await tools.logs.flush(); fs.rmSync(root, { recursive: true, force: true }) })
  const tabId = (await tools.call('list_tabs', {}))[0].id, context = { owner: 'a', logScope: 'space:a' }
  output.chunks$.next({ terminal, streamId: 's', text: 'before capture' })
  await tools.call('read_tab', { tabId, mode: 'delta' }, context)
  text = 'first needle last'
  output.chunks$.next({ terminal, streamId: 's', text })
  await tools.logs.flush()
  const listed = await tools.call('list_logs', {}, context), logId = listed[0].logId
  const page = await tools.call('read_log', { logId, maxChars: 5 }, context)
  assert.equal(page.text, 'first')
  const hits = await tools.call('search_log', { logId, query: 'needle' }, context)
  assert.equal(hits.hits.length, 1); assert.equal(hits.partial, false)
  await assert.rejects(tools.call('read_log', { logId }, { owner: 'b', logScope: 'space:b' }), /unavailable/)
  tools.releaseOwner('a')
  output.chunks$.next({ terminal, streamId: 's', text: 'after task' })
  const remaining = await tools.call('read_log', { logId, cursor: page.nextCursor }, context)
  assert.equal(remaining.text, ' needle last')
  assert.equal(remaining.logState, 'sealed')
})

test('completion waits reject an old prompt and wake only for a newer completion', async () => {
  const terminal = new FakeTerminal('Completion', [])
  const output = { watch: () => 0, unwatch: () => {}, streamId: () => 's', cursor: () => 0, updates$: new Subject(), lifecycle$: new Subject(), isSuppressed: () => false, readSince: () => ({ text: '', cursor: 0, hasMore: false, truncated: false }) }
  const tools = new TabbyTabToolsService({ tabs: [terminal], tabsChanged$: new Subject(), activeTabChange$: new Subject() }, output)
  try {
    const tabId = (await tools.call('list_tabs', {}))[0].id, context = { owner: 'a' }
    tools.completedCommands.set(terminal, terminal.session)
    tools.completionRevisions.set(terminal, 1)
    const base = await tools.call('read_tab', { tabId, mode: 'delta' }, context)
    const unchanged = await tools.call('read_tab', { tabId, mode: 'delta', cursor: base.nextCursor, waitFor: 'completion', waitMs: 10 }, context)
    assert.equal(unchanged.wakeReason, 'timeout')
    const waiting = tools.call('read_tab', { tabId, mode: 'delta', cursor: base.nextCursor, waitFor: 'completion', waitMs: 10000 }, context)
    tools.completionRevisions.set(terminal, 2); tools.controls$.next([])
    assert.equal((await waiting).wakeReason, 'completion')
    assert.deepEqual(terminal.sent, [])
  } finally { tools.ngOnDestroy() }
})

test('delta reads inherit controlled-terminal default wait and preserve explicit zero and uncontrolled defaults', async () => {
  const terminal = new FakeTerminal('Quiet', [])
  const output = { watch: () => 0, unwatch: () => {}, streamId: () => 's', cursor: () => 0, updates$: new Subject(), lifecycle$: new Subject(), isSuppressed: () => false, readSince: () => ({ text: '', cursor: 0, hasMore: false, truncated: false }) }
  const tools = new TabbyTabToolsService({ tabs: [terminal], tabsChanged$: new Subject(), activeTabChange$: new Subject() }, output)
  try {
    const tabId = (await tools.call('list_tabs', {}))[0].id, context = { owner: 'a' }
    const base = await tools.call('read_tab', { tabId, mode: 'delta' }, context)
    const waits = []
    tools.waitStream = async (_tab, _start, ms) => { waits.push(ms); return 'timeout' }
    const args = { tabId, mode: 'delta', cursor: base.nextCursor }
    assert.equal((await tools.call('read_tab', args, context)).wakeReason, 'immediate')
    tools.lock(terminal, 'a', 'quiet command')
    assert.equal((await tools.call('read_tab', args, context)).wakeReason, 'timeout')
    assert.deepEqual(waits, [1000])
    assert.equal((await tools.call('read_tab', { ...args, waitMs: 0 }, context)).wakeReason, 'immediate')
    await tools.call('read_tab', { ...args, waitMs: 2500 }, context)
    assert.deepEqual(waits, [1000, 2500])
    assert.equal(args.waitMs, undefined, 'resolved defaults must not mutate caller arguments')
    tools.release(terminal)
  } finally { tools.ngOnDestroy() }
})

test('verified SSH attachment revalidates before each answer and retains ownership across transient failures', async t => {
  const f = ownershipFixture('ssh')
  const identity = { pid: 20, tty: 'pts/3', started: '123', executable: '/opt/codex' }
  const calls = []
  t.mock.method(f.tools, 'remoteProcess', async (tab, expected, previous) => { calls.push(previous); return identity })
  try {
    const tabId = (await f.tools.call('list_tabs', {}))[0].id
    await f.tools.call('attach_process', { tabId, expectedProcess: 'codex', purpose: 'send the user message to this waiting Codex' }, f.context)
    assert.deepEqual(f.terminal.sent, [])
    await f.tools.call('send_input', { tabId, mode: 'stdin', text: 'the user request', submit: true }, f.context)
    assert.deepEqual(calls, [undefined, identity])
    assert.deepEqual(f.terminal.sent, ['the user request\r'])
    t.mock.method(f.tools, 'remoteProcess', async () => null)
    await assert.rejects(f.tools.call('send_keys', { tabId, key: 'Enter' }, f.context), /could not be revalidated/)
    assert.equal(f.tools.controls$.value.length, 1)
    assert.deepEqual(f.terminal.sent, ['the user request\r'])
    await assert.rejects(f.tools.call('send_keys', { tabId, key: 'Enter' }, { owner: 'unrelated' }), /owned/)
    await assert.rejects(f.tools.call('send_input', { tabId, mode: 'stdin', text: 'blocked' }, { ...f.context, readOnly: true }), /只读|read.only/i)
  } finally { f.tools.ngOnDestroy() }
})

test('a reconnect or stop while SSH proof is pending cannot claim input or send a late answer', async t => {
  const f = ownershipFixture('ssh'), controller = new AbortController()
  let finish
  t.mock.method(f.tools, 'remoteProcess', () => new Promise(resolve => { finish = resolve }))
  try {
    const tabId = (await f.tools.call('list_tabs', {}))[0].id
    const pending = f.tools.call('attach_process', { tabId, expectedProcess: 'codex', purpose: 'supervise' }, { ...f.context, signal: controller.signal })
    while (!finish) await new Promise(resolve => setImmediate(resolve))
    controller.abort(); finish({ pid: 20, tty: 'pts/3', started: '123', executable: '/opt/codex' })
    await assert.rejects(pending, /stopped/)
    assert.equal(f.tools.controls$.value.length, 0)
    assert.deepEqual(f.terminal.sent, [])
  } finally { f.tools.ngOnDestroy() }
})

test('MCP disables automatic takeover for both known foreground processes and unknown inspection', async () => {
  const { terminal, tools } = interactiveFixture()
  try {
    const context = { owner: 'mcp:lease', allowTakeover: false }
    const args = { text: 'pwd', submit: true, foregroundTaskNeeded: false }
    assert.equal((await tools.callTerminal('send_input', args, terminal, context)).blocked, true)
    terminal.profile.type = 'ssh'
    assert.equal((await tools.callTerminal('send_input', args, terminal, context)).blocked, true)
    assert.deepEqual(terminal.sent, [])
    assert.equal(tools.controls$.value.length, 0)
  } finally { tools.ngOnDestroy() }
})
test('MCP final permission check after lock publication blocks input and restores the terminal', async () => {
  const { terminal, tools } = interactiveFixture()
  terminal.children = []
  let authorized = true, attempts = 0
  const watcher = tools.controls$.subscribe(controls => { if (controls.length) authorized = false })
  try {
    await assert.rejects(tools.callTerminal('send_input', { text: 'pwd', submit: true }, terminal, { owner: 'mcp:lease', allowTakeover: false, beforeInput: () => { if (!authorized) throw new Error('permission revoked') }, onInput: () => { attempts++ } }), /permission revoked/)
    assert.equal(attempts, 0); assert.deepEqual(terminal.sent, []); assert.equal(tools.controls$.value.length, 0)
  } finally { watcher.unsubscribe(); tools.ngOnDestroy() }
})
test('MCP and the sidebar share atomic input ownership and explicit Ctrl+C never targets another owner', async () => {
  const { terminal, tools } = interactiveFixture()
  terminal.children = []
  try {
    await tools.callTerminal('send_input', { text: 'sleep 30', submit: true }, terminal, { owner: 'sidebar' })
    await assert.rejects(tools.callTerminal('send_input', { text: 'pwd', submit: true }, terminal, { owner: 'mcp:lease', allowTakeover: false }), /another/)
    await assert.rejects(tools.callTerminal('send_keys', { key: 'c', ctrl: true }, terminal, { owner: 'mcp:lease', allowTakeover: false }), /owned/)
    assert.deepEqual(terminal.sent, ['sleep 30\r'])
    tools.releaseOwner('sidebar')
    await tools.callTerminal('send_input', { text: 'read answer', submit: true }, terminal, { owner: 'mcp:lease', allowTakeover: false })
    await tools.callTerminal('send_keys', { key: 'c', ctrl: true }, terminal, { owner: 'mcp:lease', allowTakeover: false })
    assert.deepEqual(terminal.sent, ['sleep 30\r', 'read answer\r', '\x03'])
    tools.releaseOwner('mcp:lease');terminal.sendInput('manual');assert.equal(terminal.sent.at(-1),'manual')
  } finally { tools.ngOnDestroy() }
})
