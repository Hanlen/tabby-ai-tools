const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const ts = require('typescript')
const { once } = require('node:events')

// Load the transport in Node without bundling Angular or Tabby.
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText
  module._compile(output, filename)
}

const { CodexClient } = require('../src/codex-client.ts')
const { completionLabel } = require('../src/completion.ts')
const { IncrementalOutputBuffer } = require('../src/output-buffer.ts')

function waitForEvent (client, method) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { client.off('event', handler); reject(new Error(`Timed out waiting for ${method}`)) }, 2000)
    const handler = message => {
      if (message.method === method) {
        clearTimeout(timer)
        client.off('event', handler)
        resolve(message)
      }
    }
    client.on('event', handler)
  })
}

async function waitForProcess (client) {
  const deadline = Date.now() + 2000
  while (!client.process && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve))
  assert.ok(client.process, 'CLI discovery must spawn the initialization process')
  return client.process
}

test('completion requires both a successful turn and a completed goal', () => {
  assert.equal(completionLabel('completed', 'complete'), '任务已完成')
  assert.notEqual(completionLabel('failed', 'complete'), '任务已完成')
  assert.notEqual(completionLabel('completed', 'active'), '任务已完成')
  assert.notEqual(completionLabel('completed', 'budgetLimited'), '任务已完成')
})

test('terminal output is read once by cursor and reports lost older chunks', () => {
  const output = new IncrementalOutputBuffer(8)
  const initial = output.cursor
  output.append('abc')
  const first = output.readSince(initial, 2)
  assert.deepEqual(first, { text: 'ab', cursor: 2, truncated: false, hasMore: true })
  assert.equal(output.readSince(first.cursor, 8).text, 'c')
  output.append('defghijk')
  const late = output.readSince(first.cursor, 8)
  assert.equal(late.text, 'defghijk')
  assert.equal(late.truncated, true)
  assert.equal(output.readSince(late.cursor, 8).text, '')
})

test('app-server client reuses a process and streams JSONL notifications', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-codex-test-'))
  const executable = mockServer(dir, 'mock-codex', String.raw`
const readline = require('readline')
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', line => {
  const msg = JSON.parse(line)
  if (msg.method === 'initialize') process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + '\n')
  if (msg.method === 'thread/start') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { thread: { id: 'thread-1' } } }) + '\n')
    process.stdout.write(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', itemId: 'message-1', delta: 'hello' } }) + '\n')
    process.stdout.write(JSON.stringify({ id: 9, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', command: 'pwd' } }) + '\n')
  }
  if (msg.id === 9 && msg.result?.decision === 'accept') process.stdout.write(JSON.stringify({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 9 } }) + '\n')
})

`)
  const client = new CodexClient()
  let connectedEvents = 0
  client.on('connected', () => { connectedEvents++ })
  try {
    assert.equal(client.isConnected, false)
    await client.connect(executable)
    assert.equal(client.isConnected, true)
    assert.equal(connectedEvents, 1)
    const pid = client.process.pid
    await client.connect(executable)
    assert.equal(client.process.pid, pid)
    assert.equal(connectedEvents, 1)
    const delta = waitForEvent(client, 'item/agentMessage/delta')
    const approval = waitForEvent(client, 'item/commandExecution/requestApproval')
    const result = await client.request('thread/start', {})
    assert.equal(result.thread.id, 'thread-1')
    assert.equal((await delta).params.delta, 'hello')
    assert.equal((await approval).id, 9)
    const resolved = waitForEvent(client, 'serverRequest/resolved')
    client.respond(9, { decision: 'accept' })
    assert.equal((await resolved).params.requestId, 9)
  } finally {
    client.close()
    assert.equal(client.isConnected, false)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function mockServer (dir, name, body) {
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, `${name}.js`), body)
    const executable = path.join(dir, `${name}.cmd`)
    fs.writeFileSync(executable, `@"${process.execPath}" "%~dp0${name}.js" %*\r\n`)
    return executable
  }
  const executable = path.join(dir, name)
  fs.writeFileSync(executable, `#!${process.execPath}\n` + body, { mode: 0o755 })
  return executable
}

const echoServer = String.raw`
const rl = require('readline').createInterface({ input: process.stdin })
rl.on('line', line => {
  const msg = JSON.parse(line)
  if (msg.method === 'initialize') process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + '\n')
  else if (msg.id) process.stdout.write(JSON.stringify({ id: msg.id, result: { pid: process.pid } }) + '\n')
})
`

test('startup and panel share discovery when system space metadata arrives later', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-codex-startup-'))
  const client = new CodexClient()
  let connected = 0, disconnected = 0
  client.on('connected', () => { connected++ })
  client.on('disconnected', () => { disconnected++ })
  try {
    const executable = mockServer(dir, 'server', echoServer)
    const startup = client.connect(executable)
    const panel = client.connect(executable, { engine: 'codex', key: 'system:codex' })
    await Promise.all([startup, panel])
    const pid = client.process.pid
    await client.connect(executable)
    await client.connect(executable, { engine: 'codex', key: 'system:codex' })
    assert.equal(client.process.pid, pid)
    assert.equal(connected, 1)
    assert.equal(disconnected, 0)
    assert.equal(typeof (await client.request('ping')).pid, 'number')
  } finally {
    await client.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI paths with spaces, Unicode and shell characters are passed literally', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby codex 中文 & test-'))
  const client = new CodexClient()
  try {
    const executable = mockServer(dir, 'mock codex', echoServer)
    await client.connect(`"${executable}"`)
    const pid = client.process.pid
    assert.equal(typeof (await client.request('ping')).pid, 'number')
    await client.connect(executable)
    assert.equal(client.process.pid, pid)
  } finally {
    client.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('startup failure includes CLI stderr after streams have drained and permits retry', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-codex-stderr-'))
  const client = new CodexClient()
  try {
    const executable = mockServer(dir, 'bad', String.raw`
process.stderr.write('Cannot load Codex config: invalid value\n', () => process.exit(1))
`)
    const disconnected = once(client, 'disconnected')
    await assert.rejects(client.connect(executable), error => {
      assert.match(error.message, /exited \(1\)/)
      assert.ok(error.message.includes(executable))
      assert.match(error.message, /Cannot load Codex config: invalid value/)
      return true
    })
    assert.match((await disconnected)[0].message, /Cannot load Codex config/)
    assert.equal(client.pending.size, 0)
    await client.connect(mockServer(dir, 'good', echoServer))
    assert.equal(client.isConnected, true)
  } finally {
    client.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('bare CLI name resolves from PATH, including Windows .cmd extensions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-codex-path-'))
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'PATH'
  const previousPath = process.env[pathKey]
  const client = new CodexClient()
  try {
    mockServer(dir, 'mock-codex-from-path', echoServer)
    process.env[pathKey] = dir + path.delimiter + (previousPath || '')
    await client.connect('mock-codex-from-path')
    assert.equal(client.isConnected, true)
    assert.equal(typeof (await client.request('ping')).pid, 'number')
  } finally {
    client.close()
    if (previousPath === undefined) delete process.env[pathKey]
    else process.env[pathKey] = previousPath
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('missing executable is classified as an unavailable selector before starting a process', () => {
  const { resolveCodexExecutable, CliSelectorUnavailableError } = require('../src/codex-executable.ts')
  const executable = path.join(os.tmpdir(), `missing-codex-${process.pid}`, 'codex')
  assert.throws(() => resolveCodexExecutable(executable), error => {
    assert.ok(error instanceof CliSelectorUnavailableError)
    assert.ok(error.message.includes(executable))
    assert.match(error.message, /ENOENT/)
    return true
  })
})

test('switching executables during initialization rejects old calls and preserves the new connection', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-codex-switch-'))
  const client = new CodexClient()
  try {
    const slow = mockServer(dir, 'slow', 'setInterval(() => {}, 1000)\n')
    const fast = mockServer(dir, 'fast', echoServer)
    const first = client.connect(slow)
    const rejected = assert.rejects(first, /closed/)
    const oldChild = await waitForProcess(client)
    const exited = once(oldChild, 'exit')
    await client.connect(fast)
    await rejected
    await exited
    assert.equal(client.isConnected, true)
    const pid = client.process.pid
    const serverPid = (await client.request('ping')).pid
    assert.equal(typeof serverPid, 'number')
    assert.notEqual(pid, oldChild.pid)
    await client.connect(fast)
    assert.equal(client.process.pid, pid)
    assert.deepEqual(await client.request('ping'), { pid: serverPid })
  } finally {
    client.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('failed initialization terminates its process and permits a fresh connection', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-codex-init-'))
  const client = new CodexClient()
  try {
    const bad = mockServer(dir, 'bad', String.raw`
const rl = require('readline').createInterface({ input: process.stdin })
rl.on('line', line => {
  const msg = JSON.parse(line)
  process.stdout.write(JSON.stringify({ id: msg.id, error: { message: 'initialize rejected' } }) + '\n')
})
`)
    const first = client.connect(bad)
    const rejected = assert.rejects(first, /initialize rejected/)
    const child = await waitForProcess(client)
    const exited = once(child, 'exit')
    await rejected
    await exited
    assert.equal(client.isConnected, false)
    assert.equal(client.process, undefined)
    await client.connect(mockServer(dir, 'good', echoServer))
    assert.equal(client.isConnected, true)
    assert.equal(typeof (await client.request('ping')).pid, 'number')
  } finally {
    client.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('unexpected exit rejects pending requests and the client can reconnect', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-codex-exit-'))
  const client = new CodexClient()
  try {
    const executable = mockServer(dir, 'server', echoServer)
    // This method is deliberately left unanswered until the child exits.
    const pendingExecutable = mockServer(dir, 'pending', String.raw`
const rl = require('readline').createInterface({ input: process.stdin })
rl.on('line', line => {
  const msg = JSON.parse(line)
  if (msg.method === 'initialize') process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + '\n')
  else process.exit(3)
})
`)
    await client.connect(pendingExecutable)
    await assert.rejects(client.request('wait'), /exited \(3\)/)
    assert.equal(client.isConnected, false)
    assert.equal(client.pending.size, 0)
    await client.connect(executable)
    assert.equal(typeof (await client.request('ping')).pid, 'number')
  } finally {
    client.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('child receives plugin clientInfo and a clean environment while parent originator stays intact', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-codex-env-'))
  const client = new CodexClient()
  const keys = ['CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'codex_internal_originator_override', 'Codex_Internal_Originator_Override']
  const previous = keys.map(key => process.env[key])
  try {
    for (const key of keys) process.env[key] = 'parent-identity'
    const executable = mockServer(dir, 'identity', String.raw`
const rl = require('readline').createInterface({ input: process.stdin })
let clientInfo
rl.on('line', line => {
  const m = JSON.parse(line)
  if (m.method === 'initialize') clientInfo = m.params.clientInfo
  if (m.id) process.stdout.write(JSON.stringify({ id: m.id, result: {
    clientInfo,
    overrides: Object.keys(process.env).filter(k => k.toUpperCase() === 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE'),
    args: process.argv.slice(2),
  } }) + '\n')
})
`)
    await client.connect(executable)
    const result = await client.request('identity')
    assert.deepEqual(result.clientInfo, { name: 'tabby_codex_agent', title: 'Tabby AI Tools', version: '0.1.0' })
    assert.deepEqual(result.overrides, [])
    assert.deepEqual(result.args, ['app-server', '--listen', 'stdio://'])
    assert.equal(process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, 'parent-identity')
  } finally {
    client.close()
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i] })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

const discovery = require('../src/codex-discovery.ts')
const helperError = 'failed to spawn code-mode host: codex-code-mode-host.exe: The system cannot find the file specified. (os error 2)'

function recoveryFixture (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-install-recovery-'))
  const log = path.join(dir, 'requests.jsonl')
  const body = String.raw`
const fs = require('fs'), log = LOG_PATH
const rl = require('readline').createInterface({ input: process.stdin })
rl.on('line', line => {
  const m = JSON.parse(line)
  fs.appendFileSync(log, JSON.stringify({ method: m.method, params: m.params, cli: process.argv[1] }) + '\n')
  if (m.method === 'initialize') process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + '\n')
  else if (m.method === 'turn/start') {
    process.stdout.write(JSON.stringify({ method: 'turn/started', params: { threadId: m.params.threadId } }) + '\n')
    process.stdout.write(JSON.stringify({ id: m.id, result: { turn: { id: 'turn-original' } } }) + '\n')
  } else if (m.method === 'fault') {
    process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + '\n')
    process.stdout.write(JSON.stringify({ method: 'error', params: { threadId: m.params.threadId, error: { message: HELPER_ERROR } } }) + '\n')
  } else if (m.method === 'finish') {
    process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + '\n')
    process.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: m.params.threadId, turn: { id: 'turn-original', status: 'failed', error: { message: HELPER_ERROR } } } }) + '\n')
  } else if (m.method === 'tool') {
    process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + '\n')
    process.stdout.write(JSON.stringify({ id: 100, method: 'item/tool/call', params: { threadId: m.params.threadId } }) + '\n')
  } else if (m.id !== 100) process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + '\n')
})
`.replace('LOG_PATH', JSON.stringify(log)).replaceAll('HELPER_ERROR', JSON.stringify(helperError))
  const first = mockServer(dir, 'old-install', body), second = mockServer(dir, 'complete-install', body)
  const client = new CodexClient(), scans = []
  t.mock.method(discovery, 'resolveCodexLaunch', async (configured, context = {}) => {
    scans.push({ configured, excluded: [...(context.excludedExecutables || [])] })
    return { executable: scans.length === 1 ? first : second, env: process.env }
  })
  t.after(async () => { await client.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const requests = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  return { client, scans, first, second, dir, requests }
}

test('tool-host failure waits for all concurrent turns and pending tool replies; single recovery never replays operations', async t => {
  const f = recoveryFixture(t), c = f.client
  await c.connect('codex')
  await c.request('turn/start', { threadId: 'original', cwd: f.dir, input: [{ type: 'text', text: 'modify once' }] })
  await c.request('turn/start', { threadId: 'unrelated' })
  const failed = waitForEvent(c, 'error')
  await c.request('fault', { threadId: 'original' }); await failed
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.scans.length, 1)
  assert.equal(c.isConnected, true, 'another panel is still running')
  await assert.rejects(c.request('turn/start', { threadId: 'blocked' }), /no new task was sent/)
  const completed = waitForEvent(c, 'turn/completed')
  await c.request('finish', { threadId: 'original' }); await completed
  assert.equal(f.scans.length, 1)
  const tool = waitForEvent(c, 'item/tool/call')
  await c.request('tool', { threadId: 'unrelated' }); await tool
  const completedOther = waitForEvent(c, 'turn/completed')
  await c.request('finish', { threadId: 'unrelated' }); await completedOther
  assert.equal(f.scans.length, 1, 'a pending server request is not an idle boundary')
  c.respond(100, { success: true })
  // The actual app-server confirms server request resolution.
  const recovered = once(c, 'recovered')
  c.receive(JSON.stringify({ method: 'serverRequest/resolved', params: { requestId: 100 } }))
  c.receive(JSON.stringify({ method: 'error', params: { error: { message: helperError } } }))
  await recovered
  assert.equal(f.scans.length, 2)
  assert.deepEqual(f.scans[1].excluded, [f.first])
  assert.equal(c.isConnected, true)
  assert.equal(c.generation, 2)
  const calls = f.requests()
  assert.equal(calls.filter(x => x.method === 'initialize').length, 2)
  assert.equal(calls.filter(x => x.method === 'turn/start').length, 2, 'only the two explicit original submissions were sent')
  assert.equal(calls.filter(x => /turn\/steer|thread\/resume/.test(x.method)).length, 0, 'recovery starts no inference and does not implicitly resume active goals')
  const exhausted = once(c, 'recoveryFailed')
  c.receive(JSON.stringify({ method: 'error', params: { error: { message: helperError } } }))
  assert.match((await exhausted)[0].message, /exhausted/)
  assert.equal(f.scans.length, 2)
  await assert.rejects(c.request('turn/start', { threadId: 'again' }), /no new task/)
})

test('no alternative complete installation stops after one rescan with paths and recovery details', async t => {
  const f = recoveryFixture(t), c = f.client
  await c.connect('codex')
  t.mock.method(discovery, 'resolveCodexLaunch', async () => { f.scans.push({}); throw new Error('No complete Codex installation is available') })
  const stopped = once(c, 'recoveryFailed')
  c.receive(JSON.stringify({ method: 'error', params: { error: { message: helperError } } }))
  const error = (await stopped)[0]
  assert.match(error.message, /one rescan/); assert.ok(error.message.includes(f.first))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.scans.length, 2)
  assert.equal(c.isConnected, false)
  assert.equal(c.installationRecoveryStopped, true)
})

test('removal after successful preflight but before spawn is recovered once without a model request', async t => {
  const f = recoveryFixture(t)
  // Windows fixtures are .cmd launchers: intercept before cross-spawn rewrites
  // their path to cmd.exe, so removal really occurs at the launch boundary.
  const cp = process.platform === 'win32' ? require('cross-spawn') : require('node:child_process')
  const original = cp.spawn
  let removed = false
  t.mock.method(cp, 'spawn', (file, ...args) => {
    if (file === f.first && !removed) { removed = true; fs.unlinkSync(file) }
    return original(file, ...args)
  })
  await f.client.connect('codex')
  assert.equal(removed, true)
  assert.equal(f.client.isConnected, true)
  assert.equal(f.scans.length, 2)
  assert.deepEqual(f.scans[1].excluded, [f.first])
  assert.equal(f.requests().filter(x => x.method === 'turn/start').length, 0)
})

test('transport loss with an admitted turn leaves its state unknown and does not automatically restart or resend', async t => {
  const f = recoveryFixture(t), c = f.client
  await c.connect('codex')
  await c.request('turn/start', { threadId: 'unknown' })
  c.recordInstallationFault(new Error(helperError))
  c.disconnect(new Error('observation timed out'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.scans.length, 1)
  assert.equal(f.requests().filter(x => x.method === 'turn/start').length, 1)
})

test('reusing a connected server revalidates a deleted cached entrypoint and discovers its replacement', async t => {
  const f = recoveryFixture(t), c = f.client
  await c.connect('codex')
  fs.unlinkSync(f.first)
  const recovered = once(c, 'recovered')
  await Promise.all([c.connect('codex'), c.connect('codex')])
  await recovered
  assert.equal(c.isConnected, true)
  assert.equal(f.scans.length, 2)
  assert.deepEqual(f.scans[1].excluded, [f.first])
  assert.equal(f.requests().filter(x => x.method === 'turn/start').length, 0)
})

test('a helper removed between preflight and startup is detected in owned child stderr and replaced once', async t => {
  const f = recoveryFixture(t), helper = path.join(f.dir, 'codex-code-mode-host.exe')
  fs.writeFileSync(helper, 'fixture', { mode: 0o755 })
  const old = mockServer(f.dir, 'helper-race', `if (!require('fs').existsSync(${JSON.stringify(helper)})) { process.stderr.write(${JSON.stringify(helperError)}, () => process.exit(1)); } else {\n${echoServer}\n}`)
  t.mock.method(discovery, 'resolveCodexLaunch', async (configured, context) => {
    const file = f.scans.length === 0 ? old : f.second
    f.scans.push({ configured, excluded: [...context.excludedExecutables] })
    return { executable: file, companions: file === old ? [helper] : [], env: process.env }
  })
  const cp = process.platform === 'win32' ? require('cross-spawn') : require('node:child_process')
  const original = cp.spawn
  t.mock.method(cp, 'spawn', (file, ...args) => { if (file === old) fs.unlinkSync(helper); return original(file, ...args) })
  await f.client.connect('codex')
  assert.equal(f.client.isConnected, true)
  assert.equal(f.scans.length, 2)
  assert.deepEqual(f.scans[1].excluded, [old])
})

test('an active resumed thread is accounted for before an RPC reply can open a recovery boundary', async t => {
  const f = recoveryFixture(t), c = f.client
  await c.connect('codex')
  const pending = c.request('thread/read', { threadId: 'resumed' })
  await Promise.resolve()
  // Insert the protocol reply synchronously before the fake child can answer it.
  c.receive(JSON.stringify({ id: c.nextId, result: { thread: { id: 'resumed', status: { type: 'active' } } } }))
  await pending
  c.recordInstallationFault(new Error(helperError))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.scans.length, 1)
  assert.ok(c.activeTurns.has('resumed'))
})
