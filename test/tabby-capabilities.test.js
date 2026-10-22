const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const Module = require('node:module')
const ts = require('typescript')
const { Subject } = require('rxjs')

class Tab {
  setTitle (title) { this.title = title }
  async canClose () { return !!this.allowClose }
  destroy () { this.topmostParent.panes = this.topmostParent.panes.filter(p => p !== this) }
}
class Terminal extends Tab {}
class Split extends Tab {
  constructor (panes) { super(); this.panes = panes; for (const tab of panes) tab.topmostParent = this }
  getAllTabs () { return this.panes }
  async splitTab (tab, direction) { this.direction = direction; const pane = new Tab(); pane.topmostParent = this; this.panes.push(pane); return pane }
  maximize (tab) { this.maximized = tab }
  equalize () { this.equalized = true }
}
class Settings extends Tab {}
class SettingsTabProvider {}
class CommandProvider {}
class ToolbarButtonProvider {}
class TabContextMenuItemProvider {}
const core = { SplitTabComponent: Split, CommandProvider, ToolbarButtonProvider, TabContextMenuItemProvider,
  Command: { fromToolbarButton: button => ({ label: button.title, run: button.click }), fromMenuItem: item => ({ label: item.label, run: item.click }) } }
const load = Module._load, tsLoader = require.extensions['.ts']
Module._load = function (request, parent, isMain) {
  if (request === '@angular/core') return { Injectable: () => target => target }
  if (request === 'tabby-core') return core
  if (request === 'tabby-terminal') return { BaseTerminalTabComponent: Terminal }
  if (request === 'tabby-settings') return { SettingsTabComponent: Settings, SettingsTabProvider }
  return load.call(this, request, parent, isMain)
}
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.CommonJS, experimentalDecorators: true },
}).outputText, filename)
const { TabbyCapabilitiesService } = require('../src/tabby-capabilities.service.ts')
const { TabbyTabToolsService, TAB_TOOLS } = require('../src/tab-tools.ts')
const { TABBY_MUTATIONS } = require('../src/tabby-operations.ts')
Module._load = load
require.extensions['.ts'] = tsLoader

function fixture () {
  const pane = new Tab(), split = new Split([pane])
  const app = { tabs: [split], tabsChanged$: new Subject(), activeTabChange$: new Subject(),
    selectTab (tab) { this.selected = tab }, openNewTabRaw (params) { this.opened = params },
    closeTab: async () => {}, duplicateTab: async tab => tab, explodeTab (tab) { this.exploded = tab }, emitTabsChanged () {} }
  const items = [{ id: 'local', type: 'local', name: 'Shell', isBuiltin: true },
    { id: 'ssh-1', type: 'ssh', name: 'Server', options: { host: 'example.test', port: 22, password: 'hidden', nested: { apiKey: 'hidden' } } }]
  const profiles = { getProviders: () => [{ id: 'local', name: 'Shell' }, { id: 'ssh', name: 'SSH' }],
    getProfiles: async () => JSON.parse(JSON.stringify(items)),
    openNewTabForProfile: async p => ({ title: p.name }),
    writeProfile: async p => { items[1] = p }, newProfile: async p => items.push({ ...p, id: 'new' }), deleteProfile: async p => items.splice(items.findIndex(i => i.id === p.id), 1) }
  const counters = { ran: 0, saved: 0 }
  const providers = new Map([
    [SettingsTabProvider, [{ id: 'hotkeys', title: 'Hotkeys' }]],
    [CommandProvider, [{ provide: async () => [{ id: 'search', label: 'Search', run: async () => counters.ran++ }] }]],
    [ToolbarButtonProvider, [{ provide: () => [{ title: 'Settings', click: () => counters.ran++ }] }]],
    [TabContextMenuItemProvider, [{ getItems: async () => [{ label: 'SSH', submenu: [{ label: 'SFTP', click: () => counters.ran++ }] }, { label: 'Disabled', enabled: false, click: () => { throw new Error('disabled') } }] }]],
  ])
  const config = { store: { terminal: { fontSize: 14, password: 'secret' }, hotkeys: { search: ['Ctrl-F'] }, codexAgent: { sandbox: 'read-only' } },
    enabledServices: items => items, save: async () => counters.saved++ }
  const service = new TabbyCapabilitiesService(app, profiles, { get: token => providers.get(token) || [] }, { getHotkeyDescriptions: async () => [{ id: 'search', name: 'Search' }] }, config)
  const tabs = new TabbyTabToolsService(app, { watch () {}, unwatch () {} }, service)
  return { app, pane, split, service, tabs, items, config, counters, profiles, providers,
    call: (name, args = {}, tab = undefined, check = () => {}) => service.call(name, args, tab, check) }
}

test('live discovery, bundled skill and profiles avoid leaking credentials', async () => {
  const f = fixture()
  try {
    const cap = await f.tabs.call('get_capabilities', {})
    assert.ok(cap.tools.includes('attach_process'))
    assert.ok(cap.tools.includes('send_keys'))
    assert.deepEqual(cap.tools, TAB_TOOLS.flatMap(namespace => namespace.tools.map(tool => tool.name)))
    assert.equal(cap.profileProviders[1].id, 'ssh')
    assert.match((await f.call('read_skill')).text, /Tabby application skill/)
    assert.match((await f.call('read_skill', { section: 'operations' })).text, /SFTP/)
    assert.match((await f.call('read_skill', { section: 'upstream' })).commit, /^[a-f0-9]{40}$/)
    assert.equal(JSON.stringify(await f.call('list_profiles')).includes('hidden'), false)
    const profile = await f.call('get_profile', { profileId: 'ssh-1' })
    assert.equal(profile.options.password, '[redacted]')
    assert.equal(profile.options.nested.apiKey, '[redacted]')
    assert.equal((await f.call('open_profile', { profileId: 'ssh-1' })).opened, true)
    await assert.rejects(f.call('open_profile', { profileId: 'missing' }), /no longer exists/)
  } finally { f.tabs.ngOnDestroy() }
})

test('profile updates preserve options, built-ins and installed provider boundaries', async () => {
  const f = fixture()
  try {
    await f.call('manage_profile', { action: 'update', profileId: 'ssh-1', profile: { options: { port: 2222 } } })
    assert.equal(f.items[1].options.host, 'example.test')
    assert.equal(f.items[1].options.password, 'hidden')
    assert.equal(f.items[1].options.port, 2222)
    await assert.rejects(f.call('manage_profile', { action: 'delete', profileId: 'local' }), /Built-in/)
    await assert.rejects(f.call('manage_profile', { action: 'create', profile: { type: 'absent', name: 'Unavailable' } }), /not installed/)
    await f.call('manage_profile', { action: 'create', profile: { type: 'ssh', name: 'Other', options: { host: 'other.test' } } })
    assert.equal(f.items[2].id, 'new')
    await f.call('manage_profile', { action: 'delete', profileId: 'new' })
    assert.equal(f.items.length, 2)
    assert.equal(f.counters.saved, 3)
  } finally { f.tabs.ngOnDestroy() }
})

for (const action of ['create', 'update', 'delete']) {
  test(`profile ${action} waits for persistence and rejects a failed save`, async () => {
    const f = fixture()
    try {
      let finishSave, snapshot, returned = false
      f.config.save = () => new Promise(resolve => { finishSave = () => { snapshot = structuredClone(f.items); resolve() } })
      const args = { action, profileId: 'ssh-1', profile: { type: 'ssh', name: 'Persisted' } }
      const pending = f.call('manage_profile', args).then(result => { returned = true; return result })
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(returned, false)
      finishSave()
      assert.equal((await pending).saved, true)
      assert.equal(snapshot.some(p => p.name === 'Persisted'), action !== 'delete')
      assert.equal(snapshot.some(p => p.id === 'ssh-1'), action !== 'delete')
      const failed = fixture()
      try {
        failed.config.save = async () => { throw new Error('disk full') }
        await assert.rejects(failed.call('manage_profile', args), /disk full/)
      } finally { failed.tabs.ngOnDestroy() }
    } finally { f.tabs.ngOnDestroy() }
  })
}

test('all public command provider routes are callable and stale/wrong-context handles fail', async () => {
  const f = fixture()
  try {
    const commands = await f.call('list_commands', {}, f.pane)
    assert.deepEqual(commands.map(c => c.label), ['Settings', 'SSH > SFTP', 'Search'])
    await f.call('run_command', { commandId: commands[1].id }, f.pane)
    assert.equal(f.counters.ran, 1)
    await assert.rejects(f.call('run_command', { commandId: commands[0].id }), /context changed/)
    f.config.store.commandBlacklist = ['search']
    await assert.rejects(f.call('run_command', { commandId: commands[2].id }, f.pane), /unavailable/)
    await f.call('list_commands', {}, f.pane)
    await assert.rejects(f.call('run_command', { commandId: commands[1].id }, f.pane), /stale/)
    assert.deepEqual((await f.call('list_hotkeys'))[0].bindings, ['Ctrl-F'])
  } finally { f.tabs.ngOnDestroy() }
})

test('scoped configuration writes persist, redact, reject unsafe paths and roll back failed saves', async () => {
  const f = fixture()
  try {
    assert.equal((await f.call('read_config', { path: 'terminal' })).value.password, '[redacted]')
    await f.call('write_config', { path: 'terminal.fontSize', value: { value: 18 } })
    assert.equal(f.config.store.terminal.fontSize, 18)
    assert.equal(f.counters.saved, 1)
    for (const path of ['__proto__.polluted', 'terminal.__proto__', 'codexAgent.sandbox', 'vault', 'terminal.password', 'missing']) {
      await assert.rejects(f.call('write_config', { path, value: { value: true } }))
    }
    await assert.rejects(f.call('write_config', { path: 'terminal.fontSize', value: { value: 'bad' } }), /incompatible/)
    await assert.rejects(f.call('manage_profile', JSON.parse('{"action":"create","profile":{"options":{"__proto__":{}}}}')), /Unsafe/)
    f.config.save = async () => { throw new Error('disk full') }
    await assert.rejects(f.call('write_config', { path: 'terminal.fontSize', value: { value: 20 } }), /disk full/)
    assert.equal(f.config.store.terminal.fontSize, 18)
  } finally { f.tabs.ngOnDestroy() }
})

test('host enforces readonly on every mutation including forged direct calls', async () => {
  const f = fixture()
  try {
    for (const name of TABBY_MUTATIONS) await assert.rejects(f.tabs.call(name, {}, { owner: 'readonly', readOnly: true }), /只读/)
    assert.equal((await f.tabs.call('list_tabs', {}, { readOnly: true })).length, 1)
    assert.equal(f.counters.ran, 0)
  } finally { f.tabs.ngOnDestroy() }
})

test('stopping during discovery prevents a late profile opening or command dispatch', async () => {
  const f = fixture()
  try {
    const commands = await f.call('list_commands', {}, f.pane)
    const stopped = () => { throw new Error('stopped') }
    await assert.rejects(f.call('run_command', { commandId: commands[0].id }, f.pane, stopped), /stopped/)
    f.profiles.openNewTabForProfile = async () => { throw new Error('must not open') }
    await assert.rejects(f.call('open_profile', { profileId: 'ssh-1' }, undefined, stopped), /stopped/)
    assert.equal(f.counters.ran, 0)
  } finally { f.tabs.ngOnDestroy() }
})

test('tab and split lifecycle uses host APIs and reports blocked closure honestly', async () => {
  const f = fixture()
  try {
    const tabId = (await f.tabs.call('list_tabs', {}))[0].id
    await f.tabs.call('rename_tab', { tabId, title: 'Work' })
    assert.equal(f.pane.customTitle, 'Work')
    assert.equal((await f.tabs.call('close_tab', { tabId })).closed, false)
    await f.tabs.call('split_tab', { tabId, direction: 'r' })
    assert.equal(f.split.direction, 'r')
    assert.equal((await f.tabs.call('list_tabs', {})).length, 2)
    await f.tabs.call('layout_tabs', { tabId, action: 'maximize' })
    assert.equal(f.split.maximized, f.pane)
    await f.tabs.call('layout_tabs', { tabId, action: 'restore' })
    assert.equal(f.split.maximized, null)
    await f.tabs.call('layout_tabs', { tabId, action: 'equalize' })
    assert.equal(f.split.equalized, true)
    await f.tabs.call('open_settings', { page: 'hotkeys' })
    assert.equal(f.app.opened.inputs.activeTab, 'hotkeys')
    f.pane.allowClose = true
    assert.equal((await f.tabs.call('close_tab', { tabId })).closed, true)
    assert.equal((await f.tabs.call('list_tabs', {})).length, 1)
  } finally { f.tabs.ngOnDestroy() }
})

test('application dialogs expose visible controls, hide passwords and reject stale or disabled actions', async t => {
  const previous = global.document
  t.after(() => { if (previous === undefined) delete global.document; else global.document = previous })
  const f = fixture()
  let clicked = 0
  const button = { tagName: 'BUTTON', textContent: 'Connect', isConnected: true, getAttribute: () => null, closest: () => null, getClientRects: () => [{}], click: () => clicked++ }
  const password = { ...button, tagName: 'INPUT', textContent: '', type: 'password', value: 'never expose' }
  const hidden = { ...button, getClientRects: () => [] }
  const body = { innerText: 'App', querySelectorAll: () => [] }
  const dialog = { innerText: 'SSH connection', closest: () => null, getClientRects: () => [{}], querySelectorAll: () => [button, password, hidden] }
  let dialogs = [dialog]
  global.document = { body, querySelectorAll: () => dialogs }
  try {
    const result = await f.tabs.call('read_window', {})
    assert.equal(result.dialog, true)
    assert.equal(result.controls.length, 2)
    assert.equal(JSON.stringify(result).includes('never expose'), false)
    await f.tabs.call('interact_window', { controlId: result.controls[0].id, action: 'click' })
    assert.equal(clicked, 1)
    button.disabled = true
    await assert.rejects(f.tabs.call('interact_window', { controlId: result.controls[0].id, action: 'click' }), /disabled/)
    button.disabled = false
    dialogs = []
    await assert.rejects(f.tabs.call('interact_window', { controlId: result.controls[0].id, action: 'click' }), /stale/)
    assert.equal(clicked, 1)
  } finally { f.tabs.ngOnDestroy() }
})

test('dialog-opening commands return control while pending and record eventual outcomes', async () => {
  const f = fixture()
  let finish, fail
  f.providers.set(CommandProvider, [{ provide: async () => [{ id: 'dialog', label: 'Open dialog', run: () => new Promise((resolve, reject) => { finish = resolve; fail = reject }) }] }])
  try {
    const commands = await f.call('list_commands', {}, f.pane)
    const commandId = commands.find(c => c.nativeId === 'dialog').id
    const dispatched = await f.call('run_command', { commandId }, f.pane)
    assert.equal(dispatched.status, 'pending')
    assert.equal((await f.call('get_command_result', { operationId: dispatched.operationId })).status, 'pending')
    await assert.rejects(f.call('run_command', { commandId }, f.pane), /still pending/)
    finish()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal((await f.call('get_command_result', { operationId: dispatched.operationId })).status, 'completed')
    const other = await f.call('run_command', { commandId }, f.pane)
    fail(new Error('dialog cancelled'))
    await new Promise(resolve => setImmediate(resolve))
    const result = await f.call('get_command_result', { operationId: other.operationId })
    assert.equal(result.status, 'failed')
    assert.equal(result.error, 'dialog cancelled')
  } finally { f.tabs.ngOnDestroy() }
})
