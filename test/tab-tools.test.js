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
  return originalLoad.call(this, request, parent, isMain)
}
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, experimentalDecorators: true } }).outputText
  module._compile(output, filename)
}
const { TabbyTabToolsService, TAB_TOOLS } = require('../src/tab-tools.ts')
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
  assert.deepEqual(TAB_TOOLS[0].tools.map(tool => tool.name), ['list_tabs', 'read_tab', 'select_tab', 'send_input', 'release_tab', 'interact_tab'])
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

test('local command releases user input after its child process exits', async () => {
  const terminal = new FakeTerminal('Local', [])
  const app = { tabs: [terminal], activeTab: terminal, tabsChanged$: new Subject(), activeTabChange$: new Subject() }
  const output = { watch: () => 0, unwatch: () => {}, cursor: () => 0, readSince: () => ({ text: '' }) }
  const tools = new TabbyTabToolsService(app, output)
  try {
    const tabId = (await tools.call('list_tabs', {}))[0].id
    terminal.children = []
    await tools.call('send_input', { tabId, text: 'sleep 1', submit: true }, { owner: 'thread-1' })
    terminal.children = [{ pid: 456, command: 'sleep 1' }]
    await new Promise(resolve => setTimeout(resolve, 550))
    assert.equal(tools.controls$.value.length, 1)
    terminal.children = []
    await new Promise(resolve => setTimeout(resolve, 1100))
    assert.equal(tools.controls$.value.length, 0)
    terminal.sendInput('user input')
    assert.deepEqual(terminal.sent, ['sleep 1\r', 'user input'])
  } finally { tools.ngOnDestroy() }
})
