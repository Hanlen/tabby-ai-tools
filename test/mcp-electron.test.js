const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const { EventEmitter, once } = require('node:events')
const { PassThrough } = require('node:stream')
const { setTimeout: delay } = require('node:timers/promises')
const { pathToFileURL } = require('node:url')
const { startMcpServer } = require('../artifacts/mcp-server.cjs')
const { UtilityRequests } = require('../artifacts/mcp-utility-rpc.cjs')
const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client')
const CHANNEL = 'tabby-ai-mcp-v1'

function fixture (t, saved, behavior = {}) {
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
    let ready = behavior.autoReady !== false
    const respond = message => setImmediate(() => child.emit('message', { type: 'control-result', id: message.id, ...(spawnFailure && message.type === 'start' ? { error: 'EADDRINUSE' } : { value: { port: message.port || 45678, node: process.versions.node } }) }))
    child.postMessage = message => {
      child.messages.push(message)
      if (ready && !behavior.noControlReply && ['start', 'stop'].includes(message.type)) respond(message)
    }
    child.markReady = () => {
      ready = true; child.emit('message', { type: 'ready', node: process.versions.node })
      for (const message of child.messages) if (!behavior.noControlReply && ['start', 'stop'].includes(message.type)) respond(message)
    }
    if (behavior.autoSpawn !== false) setImmediate(() => { child.spawned = true; child.emit('spawn'); if (ready) child.markReady() })
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

test('local token-free access automatically reaches all tabs and routes to their owning renderer and cannot be rotated or revoked as a bearer client', async t => {
  const f = fixture(t), a = f.owner(1), b = f.owner(2)
  await f.invoke(a, { type: 'register' }); await f.invoke(b, { type: 'register' })
  await f.invoke(a, { type: 'enabled', enabled: true })
  await f.invoke(a, { type: 'targets', targets: [{ key: 'local-terminal', session: 'a', title: 'A' }] })
  const initial = await f.invoke(a, { type: 'state' })
  assert.equal(initial.localClient.id, 'local'); assert.deepEqual(initial.localClient.targets, initial.targets.map(t => t.id)); assert.equal(initial.localClient.mode, 'auto')
  const target = initial.targets[0]
  const state = await f.invoke(a, { type: 'state' }), child = f.children[0]
  child.emit('message', { type: 'tool', id: 'local-read', clientId: 'local', revision: state.localClient.revision, tool: 'read_tab', args: { tabId: target.id, waitMs: 0, maxLines: 100 } })
  const read = a.sent.find(item => item.message.type === 'read').message
  assert.ok(!b.sent.some(item => item.message.type === 'read'))
  f.ipc.emit(CHANNEL + '-reply', { sender: a, senderFrame: a.mainFrame }, { id: read.id, value: { text: 'local output', stream: 's', offset: 12 } })
  await new Promise(setImmediate)
  assert.equal(child.messages.find(m => m.type === 'tool-result' && m.id === 'local-read').value.text, 'local output')
  await assert.rejects(f.invoke(a, { type: 'rotate', id: 'local' }))
  await assert.rejects(f.invoke(a, { type: 'revoke', id: 'local' }))
  await f.invoke(a, { type: 'enabled', enabled: false })
  assert.ok(a.sent.at(-1).message.grants.length === 0)
  const restored = await f.invoke(a, { type: 'enabled', enabled: true })
  assert.deepEqual(restored.localClient.targets, restored.targets.map(t => t.id))
  assert.equal(restored.localClient.mode, 'auto')
})

test('SSH operations require live targets, SFTP requires approval, and reconnect retires an offline ID', async t => {
  const f = fixture(t), a = f.owner(1)
  await f.invoke(a, { type: 'register' })
  await f.invoke(a, { type: 'enabled', enabled: true })
  const register = targets => f.invoke(a, { type: 'targets', targets })
  const native = { key: 'ssh', session: 'first', title: 'SSH' }
  let state = await register([native])
  let tabId = state.targets[0].id
  const child = f.children[0]
  const call = (id, tool, args) => child.emit('message', { type: 'tool', id, clientId: 'local', revision: state.localClient.revision, tool, args: { tabId, ...args } })
  const reply = (id, result) => f.ipc.emit(CHANNEL + '-reply', { sender: a, senderFrame: a.mainFrame }, { id, value: result })
  const result = async id => {
    await new Promise(setImmediate)
    return child.messages.find(message => message.type === 'tool-result' && message.id === id)
  }
  const execution = tool => a.sent.findLast(item => item.message.type === 'execute' && item.message.tool === tool)?.message

  call('exec', 'ssh_exec', { command: 'pwd' })
  reply(execution('ssh_exec').id, { stdout: '/home/user', exitCode: 0 })
  assert.equal((await result('exec')).value.leaseId, undefined)
  const requestId = '3f5c1181-1234-4e89-a123-123456789abc'
  call('file', 'sftp_transfer', { requestId, direction: 'download', localPath: path.join(os.tmpdir(), 'result'), remotePath: '/tmp/input' })
  assert.equal((await result('file')).value.status, 'awaiting_approval')
  assert.equal(execution('sftp_transfer'), undefined)
  state = await f.invoke(a, { type: 'state' })
  assert.equal(state.approvals[0].tool, 'sftp_transfer')
  await f.invoke(a, { type: 'decide', id: state.approvals[0].id, accept: false })
  call('file-status', 'sftp_status', { transferId: requestId })
  assert.equal((await result('file-status')).value.code, 'approval_denied')
  assert.equal(execution('sftp_transfer'), undefined)

  state = await register([{ ...native, session: 'disconnected', connected: false }])
  call('old', 'ssh_exec', { command: 'pwd' })
  assert.equal((await result('old')).error, 'permission_denied')
  call('listing', 'list_tabs', {})
  const tabs = (await result('listing')).value
  assert.equal(tabs[0].connected, false)
  tabId = tabs[0].tabId
  call('offline', 'ssh_exec', { command: 'pwd' })
  assert.equal((await result('offline')).error, 'target_closed')
  call('reconnect', 'manage_tab', { action: 'reconnect' })
  state = await f.invoke(a, { type: 'state' })
  await f.invoke(a, { type: 'decide', id: state.approvals[0].id, accept: true })
  const reconnect = execution('manage_tab')
  state = await register([{ ...native, session: 'second' }])
  reply(reconnect.id, { reconnectRequested: true, connected: true })
  assert.equal((await result('reconnect')).value.connected, true)
  assert.notEqual(state.targets[0].id, tabId)
  tabId = state.targets[0].id
  call('close', 'manage_tab', { action: 'close' })
  state = await f.invoke(a, { type: 'state' })
  await f.invoke(a, { type: 'decide', id: state.approvals[0].id, accept: true })
  const close = execution('manage_tab')
  await register([])
  reply(close.id, { closed: true })
  assert.equal((await result('close')).value.closed, true)
})

test('SFTP survives a lost submission reply, deduplicates retries, and has a separate execution budget', async t => {
  const f = fixture(t), a = f.owner(1)
  await f.invoke(a, { type: 'register' })
  await f.invoke(a, { type: 'enabled', enabled: true })
  const state = await f.invoke(a, { type: 'targets', targets: [{ key: 'ssh', session: 's', title: 'SSH' }] })
  const reader = await f.invoke(a, { type: 'add', name: 'Other' })
  const other = (await f.invoke(a, { type: 'state' })).clients.find(client => client.id === reader.id)
  const child = f.children[0]
  const requestId = '3f5c1181-1234-4e89-a123-123456789abc'
  const args = { tabId: state.targets[0].id, requestId, direction: 'upload', localPath: path.join(os.tmpdir(), 'sample.bin'), remotePath: '/remote' }
  const send = (id, tool, args, client = state.localClient) => child.emit('message', { type: 'tool', id, clientId: client.id, revision: client.revision, tool, args })
  const outcome = async id => {
    await new Promise(setImmediate)
    return child.messages.find(message => message.type === 'tool-result' && message.id === id)
  }
  const status = id => send(id, 'sftp_status', { transferId: requestId })
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  try {
    send('submit', 'sftp_transfer', args)
    child.emit('message', { type: 'cancel', id: 'submit' })
    send('retry', 'sftp_transfer', args)
    const expectedPath = '/remote/.tabby-mcp-' + requestId + '/sample.bin'
    assert.equal((await outcome('retry')).value.remotePath, expectedPath)
    send('conflict', 'sftp_transfer', { ...args, remotePath: '/other' })
    send('unauthorized', 'sftp_status', { transferId: requestId }, other)
    assert.equal((await outcome('conflict')).error, 'transfer_conflict')
    assert.equal((await outcome('unauthorized')).error, 'transfer_not_found')
    const pending = await f.invoke(a, { type: 'state' })
    assert.equal(pending.approvals.length, 1)
    assert.match(pending.approvals[0].input, /sample\.bin/)
    t.mock.timers.tick(24000)
    await f.invoke(a, { type: 'decide', id: pending.approvals[0].id, accept: true })
    t.mock.timers.tick(35000)
    status('running')
    assert.equal((await outcome('running')).value.status, 'running')
    const operations = a.sent.filter(item => item.message.type === 'execute')
    assert.equal(operations.length, 1)
    assert.equal(operations[0].message.args.remotePath, expectedPath)
    f.ipc.emit(CHANNEL + '-reply', { sender: a, senderFrame: a.mainFrame }, { id: operations[0].message.id, value: { bytes: 9, hash: 'a'.repeat(64), transport: 'exec-binary' } })
    await new Promise(setImmediate)
    status('done')
    assert.deepEqual((await outcome('done')).value, { transferId: requestId, status: 'completed', direction: 'upload', localPath: args.localPath, remotePath: expectedPath, bytes: 9, hash: 'a'.repeat(64), transport: 'exec-binary' })

    const timeoutId = '3f5c1181-1234-4e89-a123-123456789abd'
    send('slow', 'sftp_transfer', { ...args, requestId: timeoutId, allowPtyFallback: true })
    const slow = (await f.invoke(a, { type: 'state' })).approvals[0]
    assert.match(slow.input, /nested SSH host/)
    await f.invoke(a, { type: 'decide', id: slow.id, accept: true })
    t.mock.timers.tick(90000)
    await new Promise(setImmediate)
    send('slow-status', 'sftp_status', { transferId: timeoutId })
    const unknown = (await outcome('slow-status')).value
    assert.equal(unknown.status, 'unknown')
    assert.equal(unknown.remotePath, '/remote/.tabby-mcp-' + timeoutId + '/sample.bin')
    assert.ok(a.sent.some(item => item.message.type === 'cancel'))
  } finally { t.mock.timers.reset() }
})

test('reading current connection instructions and checking skill conflicts do not change live grants or restart the utility', async t => {
  const f = fixture(t), a = f.owner(1)
  await f.invoke(a, { type: 'register' })
  await f.invoke(a, { type: 'enabled', enabled: true })
  await f.invoke(a, { type: 'targets', targets: [{ key: 'remote', session: 'remote-session', title: '10.0.0.3' }, { key: 'local', session: 'local-session', title: 'Local terminal' }] })
  let state = await f.invoke(a, { type: 'state' })
  const skill = path.join(f.directory, '.agents/skills/tabby-mcp')
  const stale = 'Custom stale skill requiring a bearer token'
  fs.writeFileSync(path.join(skill, 'references/connection.md'), stale)
  state = await f.invoke(a, { type: 'install-agent-skill' })
  assert.equal(state.discovery.skillInstallations[0].status, 'conflict')
  const before = JSON.stringify(state.localClient), saved = fs.readFileSync(path.join(f.directory, 'ai-tools-mcp/state.json'))
  const messages = f.children[0].messages.length
  const guide = await f.invoke(a, { type: 'agent-connection-instructions', path: '/not-an-allowed-file' })
  assert.equal(guide, fs.readFileSync(path.join(state.discovery.source, 'references/connection.md'), 'utf8'))
  assert.equal(fs.readFileSync(path.join(skill, 'references/connection.md'), 'utf8'), stale)
  assert.equal(JSON.stringify((await f.invoke(a, { type: 'state' })).localClient), before)
  assert.deepEqual(fs.readFileSync(path.join(f.directory, 'ai-tools-mcp/state.json')), saved)
  assert.equal(f.children.length, 1); assert.equal(f.children[0].killed, 0)
  assert.equal(f.children[0].messages.length, messages)
})
test('cold utility startup longer than five seconds waits for readiness before sending start exactly once', async t => {
  const f = fixture(t, undefined, { autoReady: false }), a = f.owner(1)
  await f.invoke(a, { type: 'register' })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = f.invoke(a, { type: 'enabled', enabled: true })
  pending.catch(() => undefined)
  await new Promise(setImmediate)
  const child = f.children[0]
  if (!child.spawned) await once(child, 'spawn')
  await new Promise(setImmediate)
  try {
    t.mock.timers.tick(6000); await new Promise(setImmediate)
    assert.equal(child.messages.filter(m => m.type === 'start').length, 0)
    assert.equal(child.killed, 0)
    child.markReady()
    const state = await pending
    assert.equal(state.running, true)
    assert.equal(child.messages.filter(m => m.type === 'start').length, 1)
  } finally {
    child.markReady(); t.mock.timers.tick(2000); await pending.catch(() => undefined)
    t.mock.timers.reset()
  }
})
test('HTTP startup has its own twenty-second budget after a slow runtime load', async t => {
  const f = fixture(t, undefined, { autoReady: false, noControlReply: true }), a = f.owner(1)
  await f.invoke(a, { type: 'register' })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = f.invoke(a, { type: 'enabled', enabled: true })
  pending.catch(() => undefined)
  await new Promise(setImmediate)
  const child = f.children[0]
  try {
    t.mock.timers.tick(19000); await new Promise(setImmediate)
    child.markReady(); await new Promise(setImmediate)
    const start = child.messages.find(m => m.type === 'start')
    assert.ok(start)
    t.mock.timers.tick(19999); await new Promise(setImmediate)
    assert.equal(child.messages.some(m => m.type === 'stop'), false, 'HTTP startup must still be pending after five seconds')
    assert.equal(child.killed, 0)
    child.emit('message', { type: 'control-result', id: start.id, value: { port: 45678, node: process.versions.node } })
    assert.equal((await pending).running, true)
    assert.equal(child.messages.filter(m => m.type === 'start').length, 1)
    assert.equal(f.children.length, 1)
  } finally {
    t.mock.timers.tick(20000); await new Promise(setImmediate)
    t.mock.timers.tick(250); await new Promise(setImmediate)
    await pending.catch(() => undefined)
    t.mock.timers.reset()
  }
})
for (const stage of ['spawn', 'runtime readiness', 'an HTTP reply']) test(`startup without ${stage} times out at its own stage and never replays start`, async t => {
  const noReady = stage !== 'an HTTP reply'
  const f = fixture(t, undefined, { autoSpawn: stage !== 'spawn', autoReady: !noReady, noControlReply: true }), a = f.owner(1)
  await f.invoke(a, { type: 'register' })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = f.invoke(a, { type: 'enabled', enabled: true })
  const rejected = assert.rejects(pending, stage === 'spawn' ? /process did not spawn within 20 seconds/ : noReady ? /runtime did not become ready within 20 seconds/ : /HTTP listener did not reply within 20 seconds/)
  await new Promise(setImmediate)
  const child = f.children[0]
  if (stage !== 'spawn' && !child.spawned) await once(child, 'spawn')
  await new Promise(setImmediate)
  try {
    t.mock.timers.tick(20000); await new Promise(setImmediate)
    t.mock.timers.tick(250); await new Promise(setImmediate)
    await rejected
    child.markReady(); await new Promise(setImmediate)
    assert.equal(child.messages.filter(m => m.type === 'start').length, noReady ? 0 : 1)
    assert.equal(f.children.length, 1)
    const state = await f.invoke(a, { type: 'state' })
    assert.equal(state.running, false); assert.equal(state.endpoint, '')
  } finally { t.mock.timers.reset() }
})
test('an early runtime exit reports its stage and recognized error without exposing raw stderr', async t => {
  const f = fixture(t, undefined, { autoReady: false }), a = f.owner(1)
  await f.invoke(a, { type: 'register' })
  const pending = f.invoke(a, { type: 'enabled', enabled: true })
  const rejected = assert.rejects(pending, /before the runtime became ready \(exit 1; MODULE_NOT_FOUND\)/)
  await new Promise(setImmediate)
  const child = f.children[0]
  child.stderr.write("Error: Cannot find module '/private/SECRET_FIXTURE'\ncode: 'MODULE_NOT_FOUND'\nBearer SECRET_FIXTURE\n")
  child.emit('exit', 1)
  await rejected
  const state = await f.invoke(a, { type: 'state' })
  assert.doesNotMatch(state.error, /SECRET_FIXTURE|Bearer|\/private/)
  assert.equal(child.messages.filter(m => m.type === 'start').length, 0)
})
test('MCP utility retains host OS environment while excluding system Node and loader overrides', async t => {
  // SystemRoot/TEMP are needed by Windows host processes; custom env replaces
  // Electron's inherited environment rather than merging with it.
  const keys = ['SystemRoot', 'TEMP', 'NODE_OPTIONS', 'Node_Options', 'NODE_PATH', 'Path', 'ELECTRON_RUN_AS_NODE']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  const temporary = os.tmpdir()
  for (const key of keys) process.env[key] = key === 'SystemRoot' ? 'C:\\Windows' : key === 'TEMP' ? temporary : 'fixture-override'
  t.after(() => { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key] } })
  const f = fixture(t), a = f.owner(1)
  await f.invoke(a, { type: 'register' }); await f.invoke(a, { type: 'enabled', enabled: true })
  const env = f.children[0].options.env
  assert.equal(env.SystemRoot, 'C:\\Windows'); assert.equal(env.TEMP, temporary)
  for (const [key, value] of Object.entries(env)) if (/^(path|node_options|node_path|electron_run_as_node)$/i.test(key)) assert.equal(value, '', key)
  assert.equal(env.PATH, '')
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
    child.emit('message', { type: 'tool', id, clientId: client.id, revision: (client.id === state.localClient?.id ? state.localClient : state.clients.find(x => x.id === client.id)).revision, tool, args: { tabId: target.id, text: 'printf marker', mode: 'command', submit: true, ...args } })
    await delay(2)
    return a.sent.filter(x => x.message.type === 'execute').at(-1)?.message
  }
  const reply = async (message, value = { sent: true }) => { f.ipc.emit(CHANNEL + '-reply', { sender: a, senderFrame: a.mainFrame }, { id: message.id, value }); await delay(2) }
  const result = id => child.messages.find(x => x.type === 'tool-result' && x.id === id)
  return { ...f, a, b, c, d, target, child, request, reply, result }
}
test('token-free input needs no selection or approval; unrelated tab changes preserve the lease, disable revokes it', async t => {
  const f = await writerFixture(t), local = { id: 'local' }
  const command = await f.request('local-auto', local)
  assert.ok(command)
  assert.equal((await f.invoke(f.a, { type: 'state' })).approvals.length, 0)
  await f.reply(command)
  const lease = f.result('local-auto').value.leaseId
  assert.ok(lease)
  await f.invoke(f.b, { type: 'targets', targets: [{ key: 'new', session: 'first', title: 'New tab' }] })
  await f.invoke(f.b, { type: 'targets', targets: [{ key: 'new', session: 'reconnected', title: 'New tab' }] })
  await f.invoke(f.b, { type: 'targets', targets: [] })
  let state = await f.invoke(f.a, { type: 'state' })
  assert.equal(state.leases[0].id, lease)
  const input = await f.request('local-stdin', local, 'send_input', { leaseId: lease, mode: 'stdin', text: 'answer' })
  await f.reply(input)
  assert.equal(f.result('local-stdin').value.sent, true)
  await f.invoke(f.a, { type: 'targets', targets: [{ key: 't', session: 'replacement', title: 'Write target' }] })
  state = await f.invoke(f.a, { type: 'state' })
  assert.equal(state.leases.length, 0)
  assert.notEqual(state.targets[0].id, f.target.id)
  assert.deepEqual(state.localClient.targets, [state.targets[0].id])
  await f.request('stale-target', local)
  assert.equal(f.result('stale-target').error, 'permission_denied')
  await f.invoke(f.a, { type: 'enabled', enabled: false })
  assert.equal((await f.invoke(f.a, { type: 'state' })).leases.length, 0)
  assert.equal(f.a.sent.at(-1).message.grants.length, 0)
})
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
