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

test('missing executable fails promptly with the attempted CLI path', async () => {
  const client = new CodexClient()
  const executable = path.join(os.tmpdir(), `missing-codex-${process.pid}`, 'codex')
  try {
    await assert.rejects(client.connect(executable), error => {
      assert.ok(error.message.includes(executable))
      assert.match(error.message, /ENOENT/)
      return true
    })
    assert.equal(client.pending.size, 0)
  } finally {
    client.close()
  }
})

test('switching executables during initialization rejects old calls and preserves the new connection', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-codex-switch-'))
  const client = new CodexClient()
  try {
    const slow = mockServer(dir, 'slow', 'setInterval(() => {}, 1000)\n')
    const fast = mockServer(dir, 'fast', echoServer)
    const first = client.connect(slow)
    await Promise.resolve() // CLI resolution now completes asynchronously.
    const oldChild = client.process
    const exited = once(oldChild, 'exit')
    const rejected = assert.rejects(first, /closed/)
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
    await Promise.resolve()
    const child = client.process
    const exited = once(child, 'exit')
    await assert.rejects(first, /initialize rejected/)
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
