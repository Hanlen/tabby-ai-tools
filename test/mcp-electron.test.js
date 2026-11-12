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
const { startMcpServer } = require('../artifacts/mcp-server.cjs')
const { UtilityRequests } = require('../artifacts/mcp-utility-rpc.cjs')
const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client')
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

async function writerFixture (t, mode = 'auto') {
  const f = fixture(t), a = f.owner(1), b = f.owner(2)
  await f.invoke(a, { type: 'register' }); await f.invoke(b, { type: 'register' }); await f.invoke(a, { type: 'enabled', enabled: true })
  await f.invoke(a, { type: 'targets', targets: [{ key: 't', session: 's', title: 'Write target' }] })
  const c = await f.invoke(a, { type: 'add', name: 'Writer A' }), d = await f.invoke(a, { type: 'add', name: 'Writer B' })
  const target = (await f.invoke(a, { type: 'state' })).targets[0]
  for (const client of [c, d]) { await f.invoke(a, { type: 'scope', id: client.id, targets: [target.id] }); await f.invoke(a, { type: 'mode', id: client.id, mode }) }
  const child = f.children[0]
  const request = async (id, client = c, tool = 'send_input', args = {}) => {
    const state = await f.invoke(a, { type: 'state' })
    child.emit('message', { type: 'tool', id, clientId: client.id, revision: state.clients.find(x => x.id === client.id).revision, tool, args: { tabId: target.id, text: 'printf marker', mode: 'command', submit: true, ...args } })
    await delay(2)
    return a.sent.filter(x => x.message.type === 'execute').at(-1)?.message
  }
  const reply = async (message, value = { sent: true }) => { f.ipc.emit(CHANNEL + '-reply', { sender: a, senderFrame: a.mainFrame }, { id: message.id, value }); await delay(2) }
  const result = id => child.messages.find(x => x.type === 'tool-result' && x.id === id)
  return { ...f, a, b, c, d, target, child, request, reply, result }
}
test('main issues target-bound leases, blocks another client and concurrent same-lease writes, and release only unlocks', async t => {
  const f = await writerFixture(t)
  const first = await f.request('start'); await f.reply(first)
  const lease = f.result('start').value.leaseId; assert.ok(lease)
  await f.request('other', f.d); assert.equal(f.result('other').error, 'busy')
  await f.request('forged', f.d, 'send_keys', { leaseId: lease, key: 'Enter' }); assert.equal(f.result('forged').error, 'invalid_lease')
  const interactive = await f.request('stdin', f.c, 'send_input', { leaseId: lease, mode: 'stdin', text: 'answer' })
  await f.request('parallel', f.c, 'send_keys', { leaseId: lease, key: 'Enter' }); assert.equal(f.result('parallel').error, 'busy')
  await f.reply(interactive)
  const release = await f.request('release', f.c, 'release_tab', { leaseId: lease }); await f.reply(release, { released: true })
  assert.equal((await f.invoke(f.a, { type: 'state' })).leases.length, 0)
  await f.request('stale', f.c, 'send_keys', { leaseId: lease, key: 'Enter' }); assert.equal(f.result('stale').error, 'invalid_lease')
})
test('approval is exact, target-window-only, responsive to controls and never sent after denial or revocation', async t => {
  const f = await writerFixture(t, 'confirm')
  await f.request('deny')
  let state = await f.invoke(f.a, { type: 'state' }); assert.equal(state.approvals.length, 1)
  assert.match(state.approvals[0].input, /printf marker/)
  assert.equal(f.a.sent.filter(x => x.message.type === 'execute').length, 0)
  await assert.rejects(f.invoke(f.b, { type: 'decide', id: state.approvals[0].id, accept: true }), { code: 'permission_denied' })
  await f.invoke(f.a, { type: 'decide', id: state.approvals[0].id, accept: false }); await delay(2)
  assert.equal(f.result('deny').error, 'approval_denied')
  await f.request('revoked'); state = await f.invoke(f.a, { type: 'state' })
  await f.invoke(f.a, { type: 'mode', id: f.c.id, mode: 'read_only' }); await delay(2)
  assert.equal(f.result('revoked').error, 'permission_denied')
  await assert.rejects(f.invoke(f.a, { type: 'decide', id: state.approvals[0].id, accept: true }))
  assert.equal((await f.invoke(f.a, { type: 'state' })).leases.length, 0)
})
test('approval acceptance sends once; cancellation after dispatch is unknown and frees the lease without replay', async t => {
  const f = await writerFixture(t, 'confirm'); await f.request('cancel-before-approve')
  f.child.emit('message', { type: 'cancel', id: 'cancel-before-approve' }); await delay(2)
  assert.equal(f.result('cancel-before-approve').error, 'cancelled')
  assert.equal((await f.invoke(f.a, { type: 'state' })).approvals.length, 0)
  assert.equal(f.a.sent.filter(x => x.message.type === 'execute').length, 0)
  await f.request('approve')
  const approval = (await f.invoke(f.a, { type: 'state' })).approvals[0]
  await f.invoke(f.a, { type: 'decide', id: approval.id, accept: true })
  await assert.rejects(f.invoke(f.a, { type: 'decide', id: approval.id, accept: true }))
  assert.equal(f.a.sent.filter(x => x.message.type === 'execute').length, 1)
  f.child.emit('message', { type: 'cancel', id: 'approve' }); await delay(2)
  assert.equal(f.result('approve').error, 'unknown_outcome')
  assert.equal((await f.invoke(f.a, { type: 'state' })).leases.length, 0)
  const dispatched = f.a.sent.find(x => x.message.type === 'execute').message
  await f.reply(dispatched)
  assert.equal(f.a.sent.filter(x => x.message.type === 'execute').length, 1)
})
test('approval timeout sends nothing and idle lease expiration restores input without sending keys', async t => {
  const f = await writerFixture(t, 'confirm')
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  // Deliver directly to avoid fixture delay under fake timers.
  let state = await f.invoke(f.a, { type: 'state' })
  f.child.emit('message', { type: 'tool', id: 'expired', clientId: f.c.id, revision: state.clients[0].revision, tool: 'send_input', args: { tabId: f.target.id, text: 'pwd' } })
  t.mock.timers.tick(25001); await new Promise(setImmediate)
  assert.equal(f.result('expired').error, 'approval_timeout')
  assert.equal(f.a.sent.filter(x => x.message.type === 'execute').length, 0)
  await f.invoke(f.a, { type: 'mode', id: f.c.id, mode: 'auto' }); state = await f.invoke(f.a, { type: 'state' })
  f.child.emit('message', { type: 'tool', id: 'auto', clientId: f.c.id, revision: state.clients[0].revision, tool: 'send_input', args: { tabId: f.target.id, text: 'pwd' } })
  const execute = f.a.sent.find(x => x.message.type === 'execute').message
  f.ipc.emit(CHANNEL + '-reply', { sender: f.a, senderFrame: f.a.mainFrame }, { id: execute.id, value: { sent: true } }); await Promise.resolve(); await Promise.resolve()
  t.mock.timers.tick(120001)
  assert.equal((await f.invoke(f.a, { type: 'state' })).leases.length, 0)
  assert.ok(f.a.sent.some(x => x.message.type === 'release'))
  t.mock.timers.reset()
})

for (const mode of ['legacy', { pin: '2026-07-28' }]) test(`late approval and lost renderer reply preserve unknown write outcome over HTTP: ${JSON.stringify(mode)}`, async t => {
  const f = await writerFixture(t, 'confirm')
  const rpc = new UtilityRequests(message => f.child.emit('message', message), () => {})
  const post = f.child.postMessage
  f.child.postMessage = message => { post(message); if (message.type === 'tool-result') rpc.receive(message) }
  const snapshot = f.child.messages.filter(message => message.type === 'update').at(-1).snapshot
  const server = await startMcpServer((...args) => rpc.invoke(...args), snapshot)
  const client = new Client({ name: 'late-approval', version: '1' }, { versionNegotiation: { mode } })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), { requestInit: { headers: { Authorization: 'Bearer ' + f.c.token } } }))
    let observeApproval
    const approved = new Promise(resolve => { observeApproval = resolve }), send = f.a.send
    f.a.send = (channel, message) => { send(channel, message); if (message.type === 'state' && message.state.approvals.length) observeApproval(message.state.approvals[0]) }
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const pending = client.callTool({ name: 'send_input', arguments: { tabId: f.target.id, text: 'printf once' } })
    const approval = await approved
    t.mock.timers.tick(24000)
    await f.invoke(f.a, { type: 'decide', id: approval.id, accept: true })
    const execute = f.a.sent.find(item => item.message.type === 'execute').message
    // Input may have happened; withhold its renderer reply past the utility's
    // total 33-second deadline, before main's post-approval deadline can expire.
    t.mock.timers.tick(9001)
    const result = await pending, outcome = JSON.parse(result.content[0].text)
    assert.equal(result.isError, true)
    assert.equal(outcome.code, 'unknown_outcome')
    assert.match(outcome.message, /do not automatically retry/)
    assert.doesNotMatch(outcome.message, /No input was sent/)
    const state = await f.invoke(f.a, { type: 'state' })
    assert.equal(state.approvals.length, 0); assert.equal(state.leases.length, 0)
    f.ipc.emit(CHANNEL + '-reply', { sender: f.a, senderFrame: f.a.mainFrame }, { id: execute.id, value: { sent: true } })
    await new Promise(setImmediate)
    assert.equal(f.a.sent.filter(item => item.message.type === 'execute').length, 1)
  } finally { t.mock.timers.reset(); rpc.close(); await client.close(); await server.close() }
})
