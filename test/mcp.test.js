const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const Module = require('node:module')
const { setTimeout: delay } = require('node:timers/promises')
const { Subject } = require('rxjs')
const ts = require('typescript')
const { McpPolicy, tokenDigest } = require('../artifacts/mcp-policy.cjs')
const { startMcpServer } = require('../artifacts/mcp-server.cjs')
const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client')

class Terminal { constructor (title) { this.title = title; this.sessionChanged$ = new Subject(); this.session = { open: true, output$: new Subject(), closed$: new Subject(), destroyed$: new Subject() } } }
const load = Module._load, extensions = require.extensions['.ts']
Module._load = function (name, parent, main) {
  if (name === '@angular/core') return { Injectable: () => target => target }
  if (name === 'tabby-core') return { SplitTabComponent: class {} }
  if (name === 'tabby-terminal') return { BaseTerminalTabComponent: Terminal }
  return load.call(this, name, parent, main)
}
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, experimentalDecorators: true } }).outputText, file)
const { CodexTerminalOutputService } = require('../src/terminal-output.service.ts')
const { McpTerminalReader } = require('../src/mcp-terminals.ts')
const { mcpClientConfig } = require('../src/mcp-client-config.ts')
Module._load = load; require.extensions['.ts'] = extensions
const value = result => JSON.parse(result.content[0].text)
async function invalidCall (promise) {
  try { const result = await promise; assert.equal(result.isError, true) } catch (error) { assert.equal(error.code, -32602) }
}

function policyFixture (t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-mcp-policy-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const policy = new McpPolicy(directory)
  policy.register(1, [{ key: 'one', session: 's1', title: 'one' }]); policy.register(2, [{ key: 'two', session: 's2', title: 'two' }])
  return { directory, policy, targets: [...policy.targets.keys()] }
}
test('new config stays disabled; only digests persist; restart clears concrete terminal access', t => {
  const { policy, directory, targets } = policyFixture(t)
  assert.equal(policy.enabled, false)
  const grant = policy.add('test client')
  policy.enabled = true; policy.port = 12345; policy.setScope(grant.id, targets); policy.save()
  const raw = fs.readFileSync(path.join(directory, 'state.json'), 'utf8')
  assert.ok(!raw.includes(grant.token)); assert.ok(raw.includes(tokenDigest(grant.token)))
  const next = new McpPolicy(directory)
  assert.equal(next.port, 12345); assert.equal(next.enabled, true)
  assert.deepEqual([...next.clients.get(grant.id).targets], [])
  assert.equal(next.clients.get(grant.id).revision, policy.clients.get(grant.id).revision + 1)
  assert.deepEqual(next.publicState().targets, [])
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(directory, 'state.json')).mode & 0o777, 0o600)
})
test('a partial failed permission write removes its private temporary file', t => {
  const { policy, directory } = policyFixture(t), write = fs.writeFileSync
  fs.writeFileSync = (file, data, options) => {
    if (String(file).endsWith('.tmp')) { write(file, 'partial', options); throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) }
    return write(file, data, options)
  }
  try { assert.throws(() => policy.save(), { code: 'ENOSPC' }) } finally { fs.writeFileSync = write }
  assert.deepEqual(fs.readdirSync(directory).filter(name => name.endsWith('.tmp')), [])
})
test('session replacement/window loss invalidate targets, scope and revision; title reuse cannot restore grants', t => {
  const { policy, targets } = policyFixture(t)
  const c = policy.add('one'); policy.enabled = true; policy.setScope(c.id, [targets[0]])
  const revision = policy.client(c.id).revision
  policy.register(1, [{ key: 'one', session: 'new-session', title: 'one' }])
  assert.ok(!policy.targets.has(targets[0])); assert.equal(policy.client(c.id).targets.size, 0)
  assert.throws(() => policy.authorize(c.id, revision), { code: 'permission_denied' })
  policy.removeOwner(2); assert.equal(policy.targets.size, 1)
  assert.throws(() => policy.setScope(c.id, targets), { code: 'target_stale' })
})
test('client rotation invalidates old digest without modifying a different client', t => {
  const { policy } = policyFixture(t), a = policy.add('a'), b = policy.add('b')
  const prior = policy.client(a.id).digest, other = policy.client(b.id).digest
  const rotated = policy.rotate(a.id)
  assert.notEqual(rotated.token, a.token); assert.notEqual(prior, policy.client(a.id).digest)
  assert.equal(policy.client(b.id).digest, other)
  assert.throws(() => policy.add(' ')); assert.throws(() => policy.add('a'.repeat(81)))
})

async function httpFixture (t, mode = 'legacy') {
  const f = policyFixture(t), { policy, targets } = f
  policy.enabled = true
  const grant = policy.add('a'), second = policy.add('b')
  policy.setScope(grant.id, [targets[0]]); policy.setScope(second.id, [targets[1]])
  const terminal = new Terminal('one'), terminal2 = new Terminal('two')
  const output = new CodexTerminalOutputService({ tabs: [terminal, terminal2] })
  const reader = new McpTerminalReader(output)
  const entries = [{ key: 'one', session: 's1', terminal }, { key: 'two', session: 's2', terminal: terminal2 }]
  const updateReader = () => reader.update(entries, [...policy.clients.values()].flatMap(c => [...c.targets].map(id => ({ clientId: c.id, revision: c.revision, targetId: id, key: policy.targets.get(id).key, session: policy.targets.get(id).session }))))
  updateReader()
  let activeReads = 0
  const readObservers = new Set()
  const server = await startMcpServer(async (id, revision, tool, args, signal) => {
    const client = policy.authorize(id, revision)
    if (tool === 'list_tabs') return [...client.targets].map(tabId => ({ tabId, title: policy.targets.get(tabId).title }))
    policy.authorize(id, revision, args.tabId)
    const target = policy.targets.get(args.tabId)
    activeReads++; for (const observer of readObservers) observer()
    try {
      const result = await reader.read({ clientId: id, revision, targetId: target.id, key: target.key, session: target.session, args }, signal)
      policy.authorize(id, revision, args.tabId)
      return result
    } finally { activeReads--; for (const observer of readObservers) observer() }
  }, policy.snapshot())
  const url = `http://127.0.0.1:${server.port}/mcp`
  const clients = []
  const connect = async token => {
    const client = new Client({ name: 'mcp-tests', version: '1' }, { versionNegotiation: { mode } })
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    clients.push(client); return client
  }
  t.after(async () => { for (const c of clients) await c.close(); reader.destroy(); await server.close() })
  const client = await connect(grant.token)
  const observeReads = predicate => new Promise((resolve, reject) => {
    const check = () => { if (predicate(activeReads)) { clearTimeout(timer); readObservers.delete(check); resolve() } }
    const timer = setTimeout(() => { readObservers.delete(check); reject(new Error('Expected active reads were not observed')) }, 5000)
    readObservers.add(check); check()
  })
  return { ...f, grant, second, terminal, terminal2, output, reader, server, client, connect, url, waitForReads: count => observeReads(value => value >= count), waitForReadsBelow: count => observeReads(value => value < count), waitForIdle: () => observeReads(value => value === 0), update: () => { updateReader(); server.update(policy.snapshot()) } }
}
for (const mode of ['legacy', { pin: '2026-07-28' }]) test(`client observation cancellation releases in-flight reads: ${JSON.stringify(mode)}`, async t => {
  const f = await httpFixture(t, mode)
  const cursor = value(await f.client.callTool({ name: 'read_tab', arguments: { tabId: f.targets[0] } })).nextCursor
  const controller = new AbortController()
  const pending = f.client.callTool({ name: 'read_tab', arguments: { tabId: f.targets[0], cursor, waitMs: 30000 } }, { signal: controller.signal })
  const rejected = assert.rejects(pending)
  await f.waitForReads(1); controller.abort(); await rejected
  await f.waitForIdle()
})
for (const mode of ['legacy', { pin: '2026-07-28' }]) test(`real HTTP read-only end-to-end with real output service: ${JSON.stringify(mode)}`, async t => {
  const f = await httpFixture(t, mode)
  const tools = (await f.client.listTools()).tools.map(t => t.name).sort()
  assert.deepEqual(tools, ['attach_process', 'get_capabilities', 'list_tabs', 'read_skill', 'read_tab', 'release_tab', 'send_input', 'send_keys'])
  assert.deepEqual(value(await f.client.callTool({ name: 'list_tabs', arguments: {} })).map(t => t.tabId), [f.targets[0]])
  f.terminal.session.output$.next('\x1b[32mreal subscription output\x1b[0m')
  const snapshot = value(await f.client.callTool({ name: 'read_tab', arguments: { tabId: f.targets[0] } }))
  assert.equal(snapshot.text, 'real subscription output')
  assert.equal(snapshot.fixture, undefined)
  const pending = f.client.callTool({ name: 'read_tab', arguments: { tabId: f.targets[0], cursor: snapshot.nextCursor, waitMs: 2000 } })
  await delay(30); f.terminal.session.output$.next(' fresh delta')
  assert.equal(value(await pending).text, ' fresh delta')
  assert.equal(value(await f.client.callTool({ name: 'read_tab', arguments: { tabId: f.targets[1] } })).code, 'permission_denied')
  const malformed = await f.client.callTool({ name: 'read_tab', arguments: { tabId: f.targets[0], owner: 'forged' } })
  assert.equal(malformed.isError, true)
  assert.equal(value(await f.client.callTool({ name: 'send_input', arguments: { tabId: f.targets[0], text: 'pwd' } })).code, 'permission_denied')
  for (const name of ['send_input', 'send_keys', 'attach_process', 'release_tab', 'list_logs', 'close_tab']) await invalidCall(f.client.callTool({ name, arguments: {} }))
})
test('client-bound cursors reject sharing, tampering, different target and changed grant generation', async t => {
  const f = await httpFixture(t)
  const cursor = value(await f.client.callTool({ name: 'read_tab', arguments: { tabId: f.targets[0] } })).nextCursor
  const other = await f.connect(f.second.token)
  assert.equal(value(await other.callTool({ name: 'read_tab', arguments: { tabId: f.targets[1], cursor } })).code, 'invalid_cursor')
  assert.equal(value(await f.client.callTool({ name: 'read_tab', arguments: { tabId: f.targets[0], cursor: cursor + 'x' } })).code, 'invalid_cursor')
  f.policy.setScope(f.grant.id, [f.targets[0]]); f.update()
  assert.equal(value(await f.client.callTool({ name: 'read_tab', arguments: { tabId: f.targets[0], cursor } })).code, 'invalid_cursor')
})
test('revocation during wait discards output, releases independent watch and rejects old credentials', async t => {
  const f = await httpFixture(t)
  const cursor = value(await f.client.callTool({ name: 'read_tab', arguments: { tabId: f.targets[0] } })).nextCursor
  const pending = f.client.callTool({ name: 'read_tab', arguments: { tabId: f.targets[0], cursor, waitMs: 10000 } })
  await delay(35); f.policy.clients.delete(f.grant.id); f.update()
  const denied = await pending
  assert.equal(denied.isError, true); assert.equal(value(denied).code, 'permission_denied')
  assert.equal(f.output.has(f.terminal), false)
  const response = await fetch(f.url, { headers: { Authorization: `Bearer ${f.grant.token}` } })
  assert.equal(response.status, 401); await response.text()
  assert.equal(f.output.has(f.terminal2), true)
})
test('session replacement while waiting drops the old observation and preserves an unrelated subscriber', async t => {
  const f = await httpFixture(t)
  f.output.watch(f.terminal)
  const cursor = value(await f.client.callTool({ name: 'read_tab', arguments: { tabId: f.targets[0] } })).nextCursor
  const pending = f.client.callTool({ name: 'read_tab', arguments: { tabId: f.targets[0], cursor, waitMs: 10000 } })
  await f.waitForReads(1)
  f.terminal.session = { open: true, output$: new Subject(), closed$: new Subject(), destroyed$: new Subject() }
  f.terminal.sessionChanged$.next(f.terminal.session)
  const stale = await pending
  assert.equal(stale.isError, true); assert.equal(value(stale).code, 'target_stale')
  f.policy.setScope(f.grant.id, []); f.update()
  assert.equal(f.output.has(f.terminal), true, 'another output subscriber remains attached')
  f.output.unwatch(f.terminal)
  assert.equal(f.output.has(f.terminal), false)
})
test('HTTP gates enforce token, exact host/origin, body limits and concurrent reads', async t => {
  const f = await httpFixture(t), authorization = `Bearer ${f.grant.token}`
  const raw = headers => new Promise((resolve, reject) => { const req = http.request(f.url, { headers }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)) }); req.once('error', reject); req.end() })
  assert.equal(await raw({}), 401); assert.equal(await raw({ authorization: 'Bearer no' }), 401)
  assert.equal(await raw({ authorization, host: 'evil.example' }), 403); assert.equal(await raw({ authorization, origin: 'null' }), 403)
  const response = await fetch(f.url, { method: 'POST', headers: { authorization, 'Content-Type': 'application/json', accept: 'application/json, text/event-stream' }, body: 'x'.repeat(1024 * 1024 + 1) })
  assert.equal(response.status, 413); await response.text()
  const cursor = value(await f.client.callTool({ name: 'read_tab', arguments: { tabId: f.targets[0] } })).nextCursor
  const pending = Array.from({ length: 4 }, () => f.client.callTool({ name: 'read_tab', arguments: { tabId: f.targets[0], cursor, waitMs: 10000 } }))
  await f.waitForReads(4)
  const busy = await f.client.callTool({ name: 'read_tab', arguments: { tabId: f.targets[0], cursor } })
  assert.equal(busy.isError, true); assert.equal(value(busy).code, 'busy')
  f.terminal.session.output$.next('release concurrent observations')
  await Promise.all(pending)
})
test('legacy cancellation still reaches a full observation quota without cancelling other clients with the same RPC ID', async t => {
  const f = await httpFixture(t)
  const other = await f.connect(f.second.token)
  const aCursor = value(await f.client.callTool({ name: 'read_tab', arguments: { tabId: f.targets[0] } })).nextCursor
  const bCursor = value(await other.callTool({ name: 'read_tab', arguments: { tabId: f.targets[1] } })).nextCursor
  const post = async (token, message) => {
    const response = await fetch(f.url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' }, body: JSON.stringify(message) })
    const text = await response.text()
    return { status: response.status, text }
  }
  const calls = []
  for (let id = 41; id <= 44; id++) calls.push(post(f.grant.token, { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'read_tab', arguments: { tabId: f.targets[0], cursor: aCursor, waitMs: 30000 } } }))
  await f.waitForReads(4)
  let bFinished = false
  const b = post(f.second.token, { jsonrpc: '2.0', id: 41, method: 'tools/call', params: { name: 'read_tab', arguments: { tabId: f.targets[1], cursor: bCursor, waitMs: 30000 } } }).then(value => { bFinished = true; return value })
  await f.waitForReads(5)
  const cancelled = await post(f.grant.token, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 41 } })
  assert.equal(cancelled.status, 202)
  await f.waitForReadsBelow(5)
  assert.match((await calls[0]).text, /cancelled/)
  assert.equal(bFinished, false)
  f.terminal.session.output$.next('release remaining A reads'); f.terminal2.session.output$.next('only B fresh output')
  await Promise.all(calls); assert.match((await b).text, /only B fresh output/)
})
test('read snapshot respects attachment masks and truncation; cancellation never sends terminal input', async t => {
  const f = await httpFixture(t)
  f.terminal.frontend = { xterm: { buffer: { active: { length: 1, getLine: () => ({ translateToString: () => 'x'.repeat(24000) }) } } } }
  const result = value(await f.client.callTool({ name: 'read_tab', arguments: { tabId: f.targets[0] } }))
  assert.equal(result.text.length, 20000); assert.equal(result.truncated, true)
  const release = f.output.suppress(f.terminal)
  assert.ok(!value(await f.client.callTool({ name: 'read_tab', arguments: { tabId: f.targets[0] } })).text.includes('xxxxx'))
  release()
  const cursor = result.nextCursor
  const controller = new AbortController()
  const target = f.policy.targets.get(f.targets[0])
  const pending = f.reader.read({ clientId: f.grant.id, revision: f.policy.client(f.grant.id).revision, targetId: target.id, key: 'one', session: 's1', args: { position: { stream: f.output.streamId(f.terminal), offset: 0 }, waitMs: 2000, maxLines: 100 } }, controller.signal)
  controller.abort(); await assert.rejects(pending, { code: 'cancelled' })
  assert.ok(cursor)
})
function screen (lines) {
  return { xterm: { cols: 80, modes: { applicationCursorKeysMode: true }, buffer: { active: {
    type: 'normal', baseY: 0, cursorX: 2, cursorY: lines.length - 1, length: lines.length,
    getLine: index => ({ translateToString: (_trim, start = 0, end) => lines[index].slice(start, end), getCell: () => ({ isBold: () => index === 0 }) }),
  } } } }
}
for (const primed of [false, true]) test(`attachment highlights stay private across repeated HTTP snapshots (previous reader: ${primed})`, async t => {
  const f = await httpFixture(t), secret = 'PRIVATE_ATTACHMENT_PAYLOAD', marker = 'TA_private_DONE'
  // Wrap the footer as xterm does in a narrow terminal. The highlighted payload
  // precedes it, so sanitizing that span alone cannot locate the private region.
  const lines = [secret, 'TA_private_', 'DONE:0', '$ ready']
  f.terminal.frontend = screen(lines)
  f.output.hideAttachmentOutput(f.terminal, marker)
  const release = f.output.suppress(f.terminal)
  f.terminal.session.output$.next(secret); release()
  if (primed) assert.ok(!f.output.sanitizeView(f.terminal, lines.join('\n')).includes(secret))
  for (let i = 0; i < 2; i++) {
    const snapshot = value(await f.client.callTool({ name: 'read_tab', arguments: { tabId: f.targets[0] } }))
    assert.match(snapshot.text, /ready/)
    assert.ok(!JSON.stringify(snapshot).includes(secret), 'no snapshot field may expose a masked attachment')
  }
})
test('an unmasked HTTP snapshot preserves cursor, keyboard mode and highlighted choices', async t => {
  const f = await httpFixture(t)
  f.terminal.frontend = screen(['Selected choice', 'prompt'])
  const snapshot = value(await f.client.callTool({ name: 'read_tab', arguments: { tabId: f.targets[0] } }))
  assert.equal(snapshot.text, 'Selected choice\nprompt')
  assert.deepEqual(snapshot.interaction.cursor, { column: 2, row: 1 })
  assert.equal(snapshot.interaction.applicationCursorKeysMode, true)
  assert.equal(snapshot.interaction.highlights[0].text, 'Selected choice')
})
test('copy-only client configs preserve credentials as headers and reject non-loopback endpoints', () => {
  const token = 'a'.repeat(43), url = 'http://127.0.0.1:34567/mcp'
  const toml = mcpClientConfig('codex', url, token)
  assert.match(toml, /http_headers/); assert.ok(!toml.includes('command ='))
  for (const kind of ['cursor', 'claude']) {
    const item = JSON.parse(mcpClientConfig(kind, url, token)).mcpServers.tabby
    assert.equal(item.url, url); assert.equal(item.headers.Authorization, 'Bearer ' + token)
    assert.equal(item.type, kind === 'claude' ? 'http' : undefined)
  }
  assert.throws(() => mcpClientConfig('codex', 'http://0.0.0.0:34567/mcp', token))
})

for (const mode of ['legacy', { pin: '2026-07-28' }]) test(`controlled input HTTP schema and authority: ${JSON.stringify(mode)}`, async t => {
  const { policy, targets } = policyFixture(t), grant = policy.add('writer')
  policy.enabled = true; policy.setScope(grant.id, [targets[0]]); policy.setMode(grant.id, 'auto')
  const calls = []
  const server = await startMcpServer(async (id, revision, tool, args) => { policy.authorize(id, revision, args.tabId); calls.push({ tool, args }); return { sent: true, leaseId: 'server-issued' } }, policy.snapshot())
  const client = new Client({ name: 'writer', version: '1' }, { versionNegotiation: { mode } })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), { requestInit: { headers: { Authorization: 'Bearer '+grant.token } } }))
  t.after(async () => { await client.close(); await server.close() })
  assert.equal(value(await client.callTool({ name: 'get_capabilities', arguments: {} })).inputEnabled, true)
  for (const args of [{ text: 'pwd', owner: 'sidebar' }, { text: 'pwd', foregroundTaskNeeded: false }, { text: '\x03' }]) await invalidCall(client.callTool({ name: 'send_input', arguments: { tabId: targets[0], ...args } }))
  assert.equal(calls.length, 0)
  const sent = value(await client.callTool({ name: 'send_input', arguments: { tabId: targets[0], text: 'pwd' } }))
  assert.equal(sent.leaseId, 'server-issued'); assert.equal(calls[0].args.submit, true); assert.equal(calls[0].args.mode, 'command')
  for (const [name, args] of [['send_keys', { leaseId: sent.leaseId, key: 'c', ctrl: true }], ['send_input', { text: 'answer', mode: 'stdin', leaseId: sent.leaseId }], ['release_tab', { leaseId: sent.leaseId }], ['attach_process', { expectedProcess: 'codex', purpose: 'User requested supervising this agent' }]]) assert.equal((await client.callTool({ name, arguments: { tabId: targets[0], ...args } })).isError, undefined)
  policy.setMode(grant.id, 'read_only'); server.update(policy.snapshot())
  assert.equal(value(await client.callTool({ name: 'send_keys', arguments: { tabId: targets[0], leaseId: sent.leaseId, key: 'Enter' } })).code, 'permission_denied')
})

test('write mode is explicit and is not restored from saved permissions', t => {
  const { policy, directory } = policyFixture(t), client = policy.add('writer')
  assert.equal(policy.client(client.id).mode, 'read_only')
  policy.setMode(client.id, 'auto'); policy.save()
  assert.equal(new McpPolicy(directory).client(client.id).mode, 'read_only')
  assert.throws(() => policy.setMode(client.id, 'unrestricted'), { code: 'permission_denied' })
})

for (const mode of ['legacy', { pin: '2026-07-28' }]) test(`HTTP write timeouts are uncertain even without an aborted request signal: ${JSON.stringify(mode)}`, async t => {
  const { policy, targets } = policyFixture(t), grant = policy.add('writer')
  policy.enabled = true; policy.setScope(grant.id, [targets[0]]); policy.setMode(grant.id, 'auto')
  let code = 'observation_timeout', calls = 0
  const server = await startMcpServer(async () => { calls++; throw Object.assign(new Error(code), { code }) }, policy.snapshot())
  const client = new Client({ name: 'timeout', version: '1' }, { versionNegotiation: { mode } })
  t.after(async () => { await client.close(); await server.close() })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), { requestInit: { headers: { Authorization: 'Bearer ' + grant.token } } }))
  const write = () => client.callTool({ name: 'send_input', arguments: { tabId: targets[0], text: 'printf once' } })
  for (code of ['observation_timeout', 'cancelled']) {
    const result = await write()
    assert.equal(result.isError, true); assert.equal(value(result).code, 'unknown_outcome')
    assert.match(value(result).message, /do not automatically retry/)
  }
  code = 'observation_timeout'
  const read = await client.callTool({ name: 'read_tab', arguments: { tabId: targets[0] } })
  assert.equal(value(read).code, 'observation_timeout')
  for (code of ['approval_denied', 'approval_timeout', 'permission_denied', 'busy']) assert.equal(value(await write()).code, code)
  assert.equal(calls, 7, 'failed operations must not be retried by the server')
})
