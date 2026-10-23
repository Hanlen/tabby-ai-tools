const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { once } = require('node:events')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  }).outputText, filename)
}
const helpers = require('../src/codex-process.ts')
const { CodexClient } = require('../src/codex-client.ts')
const posix = { skip: process.platform === 'win32', timeout: 10000 }

function fixture (t, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby lifecycle 中文 space-'))
  const executable = path.join(root, 'codex')
  fs.writeFileSync(executable, '#!' + process.execPath + '\n' + body, { mode: 0o755 })
  const client = new CodexClient()
  t.after(async () => { await client.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }) })
  return { root, executable, client }
}

const server = `
require('readline').createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line)
  if(m.id) process.stdout.write(JSON.stringify({id:m.id,result:{pid:process.pid}})+'\\n')
})
`

test('Windows taskkill location is absolute and independent of PATH and environment-key casing', () => {
  assert.equal(helpers.windowsTaskkillPath({ sYsTeMrOoT: 'D:\\Windows', PATH: '' }), 'D:\\Windows\\System32\\taskkill.exe')
  assert.equal(helpers.windowsTaskkillPath({ windir: 'C:\\Windows' }), 'C:\\Windows\\System32\\taskkill.exe')
  assert.throws(() => helpers.windowsTaskkillPath({ PATH: '' }), /SystemRoot/)
  assert.throws(() => helpers.windowsTaskkillPath({ SystemRoot: 'relative' }), /绝对路径/)
})

test('close escalates SIGTERM to SIGKILL, and reconnect waits for the previous server to exit', posix, async t => {
  const { client, executable } = fixture(t, "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)\n" + server)
  await client.connect(executable)
  const old = client.process
  const stopped = client.close()
  assert.equal(client.isConnected, false)
  const replacement = client.connect(executable)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(client.process, undefined, 'new process must wait for termination')
  await stopped
  assert.equal(old.signalCode, 'SIGKILL')
  assert.throws(() => process.kill(old.pid, 0), { code: 'ESRCH' })
  await replacement
  assert.notEqual(client.process.pid, old.pid)
  assert.equal(client.isConnected, true)
})

test('close reaps descendants that ignore SIGTERM, including after the group leader exits', posix, async t => {
  const body = `
const child = require('child_process').spawn(process.execPath, ['-e',
  "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.send('ready')"
], {stdio:['ignore','inherit','inherit','ipc']})
let ready = false
const pending = []
function reply(m) { if(m.id) process.stdout.write(JSON.stringify({id:m.id,result:{descendant:child.pid}})+'\\n') }
child.on('message',()=>{ready=true;pending.splice(0).forEach(reply)})
require('readline').createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line); if(ready)reply(m);else pending.push(m)
})
`
  const { client, executable } = fixture(t, body)
  await client.connect(executable)
  const old = client.process
  const { descendant } = await client.request('ping')
  t.after(() => { try { process.kill(descendant, 'SIGKILL') } catch {} })
  await client.close()
  assert.ok(old.signalCode || old.exitCode !== null)
  // A killed orphan can briefly remain as a zombie on Linux containers. It
  // cannot execute work; on macOS and on reaping hosts ESRCH is sufficient.
  let alive = true
  try { process.kill(descendant, 0) } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error }
  if (alive && process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${descendant}/stat`, 'utf8')
      assert.match(stat.slice(stat.lastIndexOf(')') + 1), /^ Z /)
    } catch (error) {
      // The kernel can reap the zombie after kill(pid, 0) succeeds.
      if (error.code !== 'ENOENT') throw error
    }
  } else assert.equal(alive, false)
})

test('failed cleanup is reported and blocks starting another service', posix, async t => {
  const { client, executable } = fixture(t, server)
  await client.connect(executable)
  const old = client.process
  const original = helpers.terminateCodexProcess
  helpers.terminateCodexProcess = async () => { throw new Error('fixture cleanup could not confirm termination') }
  const diagnostic = once(client, 'diagnostic')
  try {
    await assert.rejects(client.close(), /could not confirm termination/)
    assert.match((await diagnostic)[0], /could not confirm termination/)
    await assert.rejects(client.connect(executable), /could not confirm termination/)
    assert.equal(client.process, undefined)
    assert.equal(client.isConnected, false)
  } finally {
    helpers.terminateCodexProcess = original
    const closed = once(old, 'close')
    process.kill(-old.pid, 'SIGKILL')
    await closed
  }
})

test('unexpected parent exit is detected even when a descendant keeps stdout open and no RPC is pending', posix, async t => {
  const body = `
const child = require('child_process').spawn(process.execPath, ['-e',
  "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.send('ready')"
], {stdio:['ignore','inherit','inherit','ipc']})
child.once('message',()=>{
  require('readline').createInterface({input:process.stdin}).on('line',line=>{
    const m=JSON.parse(line)
    if(m.id)process.stdout.write(JSON.stringify({id:m.id,result:{descendant:child.pid}})+'\\n')
    if(m.method==='crash')setTimeout(()=>process.exit(7),0)
  })
})
`
  const { client, executable } = fixture(t, body)
  await client.connect(executable)
  const disconnected = once(client, 'disconnected')
  const { descendant } = await client.request('crash')
  t.after(() => { try { process.kill(descendant, 'SIGKILL') } catch {} })
  let timer
  try {
    const [error] = await Promise.race([
      disconnected,
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('exit was not detected')), 2000) }),
    ])
    assert.match(error.message, /exited \(7\)/)
    assert.equal(client.isConnected, false)
    await client.close()
  } finally { clearTimeout(timer) }
})

test('Windows empty PATH closes a cmd launcher and its persistent Node child', { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby tree 中文 space-'))
  const inherited = { ...process.env }
  const client = new CodexClient()
  t.after(async () => {
    await client.close().catch(() => {})
    for (const key of Object.keys(process.env)) if (!(key in inherited)) delete process.env[key]
    Object.assign(process.env, inherited)
    fs.rmSync(root, { recursive: true, force: true })
  })
  fs.writeFileSync(path.join(root, 'server.js'), 'setInterval(()=>{},1000)\n' + server)
  const executable = path.join(root, 'codex.cmd')
  fs.writeFileSync(executable, `@echo off\r\n"${process.execPath}" "%~dp0server.js" %*\r\n`)
  for (const key of Object.keys(process.env)) if (key.toLowerCase() === 'path') process.env[key] = ''
  await client.connect(executable)
  const launcher = client.process
  const { pid } = await client.request('ping')
  assert.notEqual(pid, launcher.pid)
  await client.close()
  assert.throws(() => process.kill(pid, 0))
  assert.ok(launcher.signalCode || launcher.exitCode !== null)
})
