const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { setTimeout: delay } = require('node:timers/promises')
const { pathToFileURL } = require('node:url')
const CHANNEL = 'tabby-ai-mcp-v1'

function fixture (t, saved) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-mcp-main-'))
  if (saved) {
    fs.mkdirSync(path.join(directory, 'ai-tools-mcp'))
    fs.writeFileSync(path.join(directory, 'ai-tools-mcp/state.json'), JSON.stringify({ version: 1, clients: [], ...saved }))
  }
  const oldDirectory = process.env.TABBY_CONFIG_DIRECTORY
  process.env.TABBY_CONFIG_DIRECTORY = directory
  const ipc = new EventEmitter(), app = new EventEmitter(), children = [], handlers = new Map(), owners = []
  ipc.handle = (name, fn) => handlers.set(name, fn)
  const appPath = path.join(directory, 'tabby', 'app')
  app.isReady = () => true; app.getPath = () => directory; app.getAppPath = () => appPath
  let spawnFailure = false
  const electron = { app, ipcMain: ipc, utilityProcess: { fork (entry, _args, options) {
    const child = new EventEmitter()
    child.entry = entry; child.options = options; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.messages = []; child.killed = 0
    child.postMessage = message => {
      child.messages.push(message)
      if (['start', 'stop'].includes(message.type)) setImmediate(() => child.emit('message', { type: 'control-result', id: message.id, ...(spawnFailure && message.type === 'start' ? { error: 'EADDRINUSE' } : { value: { port: message.port || 45678, node: process.versions.node } }) }))
    }
    child.kill = () => { child.killed++; setImmediate(() => child.emit('exit', 0)); return true }
    children.push(child); return child
  } } }
  const original = Module._load, file = require.resolve('../dist/mcp/electron-host.cjs')
  delete require.cache[file]; delete global[Symbol.for('tabby-ai.mcp.host.v1')]
  Module._load = function (name, parent, main) { return name === 'electron' ? electron : original.call(this, name, parent, main) }
  try { require(file).install() } finally { Module._load = original }
  const owner = id => {
    const sender = new EventEmitter(); sender.id = id; sender.mainFrame = {}; sender.destroyed = false; sender.sent = []
    sender.isDestroyed = () => sender.destroyed; sender.getURL = () => pathToFileURL(path.join(appPath, 'dist/index.html')).href
    sender.send = (channel, message) => sender.sent.push({ channel, message })
    owners.push(sender); return sender
  }
  const invoke = (sender, message, frame = sender.mainFrame) => handlers.get(CHANNEL)({ sender, senderFrame: frame }, message)
  t.after(async () => {
    for (const sender of owners) await invoke(sender, { type: 'unregister' }).catch(() => undefined)
    delete global[Symbol.for('tabby-ai.mcp.host.v1')]; delete require.cache[file]
    if (oldDirectory === undefined) delete process.env.TABBY_CONFIG_DIRECTORY; else process.env.TABBY_CONFIG_DIRECTORY = oldDirectory
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return { owner, invoke, ipc, children, directory, failure: (value = true) => { spawnFailure = value } }
}
test('default-off singleton registers actual sender identity; two windows share the bundled utility', async t => {
  const f = fixture(t), a = f.owner(1), b = f.owner(2)
  assert.equal((await f.invoke(a, { type: 'register', windowId: 999 })).enabled, false)
  assert.equal(f.children.length, 0)
  await assert.rejects(f.invoke(b, { type: 'register' }, {}), /Untrusted/)
  await f.invoke(b, { type: 'register' }); await f.invoke(a, { type: 'enabled', enabled: true })
  assert.equal(f.children.length, 1)
  const child = f.children[0]
  assert.match(child.entry, /mcp[/\\]utility\.cjs$/)
  assert.equal(child.options.env.PATH, ''); assert.equal(child.options.env.NODE_OPTIONS, '')
  await f.invoke(a, { type: 'targets', targets: [{ key: 'tab-1', session: 'a', title: 'A' }] })
  await f.invoke(b, { type: 'targets', targets: [{ key: 'tab-1', session: 'b', title: 'B' }] })
  const state = await f.invoke(a, { type: 'state' })
  assert.equal(state.targets.length, 2); assert.notEqual(state.targets[0].id, state.targets[1].id)
  await f.invoke(a, { type: 'unregister' })
  assert.equal(child.killed, 0); assert.equal((await f.invoke(b, { type: 'state' })).targets.length, 1)
  await f.invoke(b, { type: 'unregister' }); assert.equal(child.killed, 1)
})
test('only the intended renderer can complete a read; revoke while waiting drops the payload', async t => {
  const f = fixture(t), a = f.owner(1), b = f.owner(2)
  await f.invoke(a, { type: 'register' }); await f.invoke(b, { type: 'register' }); await f.invoke(a, { type: 'enabled', enabled: true })
  await f.invoke(a, { type: 'targets', targets: [{ key: 'local', session: 'a', title: 'A' }] })
  const grant = await f.invoke(a, { type: 'add', name: 'client' })
  const target = (await f.invoke(a, { type: 'state' })).targets[0]
  await f.invoke(a, { type: 'scope', id: grant.id, targets: [target.id] })
  const state = await f.invoke(a, { type: 'state' }), child = f.children[0]
  const message = { type: 'tool', id: 'network-1', clientId: grant.id, revision: state.clients[0].revision, tool: 'read_tab', args: { tabId: target.id, waitMs: 1000, maxLines: 100 } }
  child.emit('message', message)
  const read = a.sent.find(item => item.message.type === 'read').message
  const response = { id: read.id, value: { text: 'private', stream: 's', offset: 7 } }
  f.ipc.emit(CHANNEL + '-reply', { sender: b, senderFrame: b.mainFrame }, response)
  await delay(10); assert.ok(!child.messages.some(m => m.type === 'tool-result'))
  await f.invoke(a, { type: 'scope', id: grant.id, targets: [] })
  f.ipc.emit(CHANNEL + '-reply', { sender: a, senderFrame: a.mainFrame }, response)
  await delay(10)
  const result = child.messages.find(m => m.type === 'tool-result')
  assert.equal(result.error, 'permission_denied'); assert.equal(result.value, undefined)
  assert.ok(a.sent.some(item => item.message.type === 'cancel'))
})
test('occupied saved port is reported without switching or killing unrelated processes', async t => {
  const f = fixture(t), a = f.owner(1)
  await f.invoke(a, { type: 'register' }); await f.invoke(a, { type: 'port', port: 43210 }); f.failure()
  await assert.rejects(f.invoke(a, { type: 'enabled', enabled: true }), /port is occupied/)
  assert.equal(f.children.length, 1); assert.equal(f.children[0].messages.find(m => m.type === 'start').port, 43210)
  assert.equal(f.children[0].killed, 1)
  const state = await f.invoke(a, { type: 'state' }); assert.equal(state.running, false); assert.equal(state.port, 43210)
})
test('utility crash does not replay reads or restore target grants; restart is an explicit action', async t => {
  const f = fixture(t), a = f.owner(1)
  await f.invoke(a, { type: 'register' }); await f.invoke(a, { type: 'enabled', enabled: true })
  await f.invoke(a, { type: 'targets', targets: [{ key: 't', session: 'a', title: 'A' }] })
  const grant = await f.invoke(a, { type: 'add', name: 'client' }), target = (await f.invoke(a, { type: 'state' })).targets[0]
  await f.invoke(a, { type: 'scope', id: grant.id, targets: [target.id] })
  f.children[0].emit('exit', 1)
  await delay(10)
  const state = await f.invoke(a, { type: 'state' })
  assert.equal(state.running, false); assert.deepEqual(state.clients[0].targets, []); assert.match(state.error, /no request was replayed/)
  await f.invoke(a, { type: 'register' }); assert.equal(f.children.length, 1)
  await f.invoke(a, { type: 'enabled', enabled: false }); await f.invoke(a, { type: 'enabled', enabled: true })
  assert.equal(f.children.length, 2)
  assert.equal(f.children[1].messages.filter(m => m.type === 'tool').length, 0)
})
test('background startup failure still registers the renderer and accepts terminal metadata for explicit recovery', async t => {
  const f = fixture(t, { enabled: true, port: 43210 }), a = f.owner(1)
  f.failure()
  const failed = await f.invoke(a, { type: 'register' })
  assert.equal(failed.enabled, true); assert.equal(failed.running, false); assert.match(failed.error, /port is occupied/)
  await f.invoke(a, { type: 'targets', targets: [{ key: 't', session: 's', title: 'Still discoverable' }] })
  await f.invoke(a, { type: 'enabled', enabled: false }); f.failure(false)
  const recovered = await f.invoke(a, { type: 'enabled', enabled: true })
  assert.equal(recovered.running, true); assert.equal(recovered.targets[0].title, 'Still discoverable')
})
test('a renderer send failure settles its read and does not block revocation or another window', async t => {
  const f = fixture(t), a = f.owner(1), b = f.owner(2)
  await f.invoke(a, { type: 'register' }); await f.invoke(b, { type: 'register' }); await f.invoke(a, { type: 'enabled', enabled: true })
  await f.invoke(a, { type: 'targets', targets: [{ key: 't', session: 's', title: 'A' }] })
  const grant = await f.invoke(a, { type: 'add', name: 'client' })
  const target = (await f.invoke(a, { type: 'state' })).targets[0]
  await f.invoke(a, { type: 'scope', id: grant.id, targets: [target.id] })
  const before = await f.invoke(a, { type: 'state' }), child = f.children[0]
  child.emit('message', { type: 'tool', id: 'failed-window-read', clientId: grant.id, revision: before.clients[0].revision, tool: 'read_tab', args: { tabId: target.id, waitMs: 30000, maxLines: 100 } })
  a.send = () => { throw new Error('WebContents was destroyed before send') }
  await f.invoke(b, { type: 'revoke', id: grant.id })
  await delay(10)
  const result = child.messages.find(m => m.type === 'tool-result' && m.id === 'failed-window-read')
  assert.ok(result); assert.ok(result.error); assert.equal(result.value, undefined)
  assert.equal((await f.invoke(b, { type: 'state' })).running, true)
})
test('utility error cannot be mistaken for an observed exit or permit an overlapping replacement', async t => {
  const f = fixture(t), a = f.owner(1)
  await f.invoke(a, { type: 'register' }); await f.invoke(a, { type: 'enabled', enabled: true })
  const old = f.children[0]
  old.kill = () => { old.killed++; return true }
  old.emit('error', new Error('utility IPC failed'))
  const pending = f.invoke(a, { type: 'enabled', enabled: true })
  // An explicit retry may wait for cleanup or reject; it may not overlap children.
  pending.catch(() => undefined)
  await delay(20)
  try { assert.equal(f.children.length, 1) }
  finally { old.emit('exit', 1) }
  await pending.catch(() => undefined)
  await f.invoke(a, { type: 'enabled', enabled: false })
})
test('unobserved termination reaches its deadline while retaining the process slot', async t => {
  const f = fixture(t), a = f.owner(1)
  await f.invoke(a, { type: 'register' }); await f.invoke(a, { type: 'enabled', enabled: true })
  const old = f.children[0]
  old.kill = () => { old.killed++; return false }
  try {
    await assert.rejects(f.invoke(a, { type: 'enabled', enabled: false }), /exit not observed/)
    const state = await f.invoke(a, { type: 'state' })
    assert.equal(state.running, false); assert.match(state.error, /slot is retained/)
    await assert.rejects(f.invoke(a, { type: 'enabled', enabled: true }), /exit not observed/)
    assert.equal(f.children.length, 1)
  } finally { old.emit('exit', 1) }
})
