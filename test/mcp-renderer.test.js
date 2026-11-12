const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const { EventEmitter } = require('node:events')
const { Subject, BehaviorSubject } = require('rxjs')
const ts = require('typescript')
const CHANNEL = 'tabby-ai-mcp-v1'
class Terminal {
  constructor (title) { this.title = title; this.session = { open: true, closed$: new Subject(), destroyed$: new Subject() }; this.sessionChanged$ = new Subject() }
}
class Split {}
const oldLoad = Module._load, oldTs = require.extensions['.ts'], oldPug = require.extensions['.pug'], oldCss = require.extensions['.css']
Module._load = function (name, parent, main) {
  if (name === '@angular/core') return { Injectable: () => value => value, Component: () => value => value }
  if (name === 'tabby-core') return { SplitTabComponent: Split }
  if (name === 'tabby-terminal') return { BaseTerminalTabComponent: Terminal }
  return oldLoad.call(this, name, parent, main)
}
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.CommonJS, experimentalDecorators: true } }).outputText, file)
require.extensions['.pug'] = module => { module.exports = '' }
require.extensions['.css'] = module => { module.exports = '' }
const { McpService } = require('../src/mcp.service.ts')
const { McpSettingsComponent } = require('../src/mcp-settings.component.ts')
const { emptyMcpState } = require('../src/mcp-types.ts')
Module._load = oldLoad; require.extensions['.ts'] = oldTs; require.extensions['.pug'] = oldPug; require.extensions['.css'] = oldCss
const flush = () => new Promise(resolve => setImmediate(resolve))

async function renderer (t) {
  const app = { tabs: [new Terminal('A')], tabsChanged$: new Subject() }, ipc = new EventEmitter(), requests = []
  const output = { watch: () => 0, unwatch: () => {}, streamId: () => 'stream', cursor: () => 0, isClosed: () => false, isSuppressed: () => false, readSince: () => ({ text: 'observed', cursor: 0, truncated: false, hasMore: false }), updates$: new Subject(), lifecycle$: new Subject() }
  let hook
  ipc.invoke = (_channel, message) => {
    requests.push(message)
    try { return Promise.resolve(hook ? hook(message) : emptyMcpState()) } catch (error) { return Promise.reject(error) }
  }
  ipc.send = () => undefined
  const remote = { getGlobal: () => ({ getBuiltinModule: () => ({ createRequire: () => () => ({ install: () => undefined }) }) }) }
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron')
  Object.defineProperty(process.versions, 'electron', { value: 'fixture', configurable: true })
  Module._load = function (name, parent, main) { return name === '@electron/remote' ? remote : name === 'electron' ? { ipcRenderer: ipc } : oldLoad.call(this, name, parent, main) }
  const service = new McpService(app, output, { run: fn => fn() })
  const started = service.start()
  Module._load = oldLoad
  await started; await flush()
  t.after(() => { service.ngOnDestroy(); if (descriptor) Object.defineProperty(process.versions, 'electron', descriptor); else delete process.versions.electron })
  return { service, app, ipc, requests, hook: value => { hook = value } }
}
test('terminal change arriving between metadata drain and finally is not lost', async t => {
  const f = await renderer(t)
  let resolve
  f.hook(message => message.type === 'targets' ? new Promise(done => { resolve = done }) : emptyMcpState())
  f.app.tabsChanged$.next()
  f.hook(undefined)
  resolve(emptyMcpState())
  queueMicrotask(() => { f.app.tabs = [new Terminal('B')]; f.app.tabsChanged$.next() })
  await flush(); await flush()
  const final = f.requests.filter(r => r.type === 'targets').at(-1)
  assert.match(final.targets[0].title, /^B /)
})
test('explicit refresh republishes metadata after a prior publication failure', async t => {
  const f = await renderer(t)
  f.hook(message => { if (message.type === 'targets') throw new Error('metadata IPC unavailable'); return emptyMcpState() })
  f.app.tabsChanged$.next(); await flush()
  const failed = f.requests.filter(r => r.type === 'targets').length
  f.hook(undefined)
  await f.service.action('state'); await flush()
  assert.ok(f.requests.filter(r => r.type === 'targets').length > failed)
})
test('read reply IPC failure is contained and destruction clears pending reads', async t => {
  const f = await renderer(t)
  const entry = [...f.service.entries.values()][0]
  f.ipc.emit(CHANNEL, {}, { type: 'state', state: emptyMcpState(), grants: [{ clientId: 'c', revision: 1, targetId: 't', key: entry.key, session: entry.session }] })
  f.ipc.send = () => { throw new Error('Renderer context is closing') }
  f.ipc.emit(CHANNEL, {}, { type: 'read', id: 'call', clientId: 'c', revision: 1, targetId: 't', key: entry.key, session: entry.session, args: { waitMs: 0, maxLines: 10 } })
  await flush(); await flush()
  assert.equal(f.service.reads.size, 0)
})

function settings (t, action) {
  const initial = { ...emptyMcpState(), enabled: true, running: true, endpoint: 'http://127.0.0.1:43210/mcp', clients: [{ id: 'a', name: 'A', revision: 1, targets: ['t'] }] }
  const changes$ = new BehaviorSubject(initial), service = { changes$, start: async () => {}, action: (type, args) => action(type, args, changes$.value), get state () { return changes$.value } }
  const component = new McpSettingsComponent(service, { setClipboard: () => {} }, { markForCheck: () => {} })
  t.after(() => component.ngOnDestroy())
  return { component, changes$ }
}
test('failed uncheck restores actual terminal scope and enabled state instead of showing a successful revoke', async t => {
  const f = settings(t, async (type, _args, state) => { if (type === 'state') return state; throw new Error('write failed') })
  const scope = { checked: false }, enabled = { checked: false }
  await f.component.scope('t', false, scope); assert.equal(scope.checked, true)
  await f.component.toggle(false, enabled); assert.equal(enabled.checked, true)
  const mode = { value: 'auto' }; await f.component.setMode('auto', mode); assert.equal(mode.value, 'read_only')
  assert.match(f.component.notice, /write failed/)
})
test('late rotated credential cannot attach to a different selected client', async t => {
  let resolve
  const f = settings(t, (type, _args, state) => type === 'state' ? Promise.resolve(state) : new Promise(done => { resolve = done }))
  const pending = f.component.rotate()
  f.changes$.next({ ...f.changes$.value, clients: [{ id: 'b', name: 'B', revision: 1, targets: [] }] })
  resolve({ id: 'a', token: 'a'.repeat(43) })
  await pending
  assert.equal(f.component.selectedId, 'b'); assert.equal(f.component.token, '')
})
