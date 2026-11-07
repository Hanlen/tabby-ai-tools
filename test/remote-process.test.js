const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
const { Subject } = require('rxjs')
require.extensions['.ts'] = (m, file) => m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
}).outputText, file)
const { verifyRemoteProcess, parseRemoteProcesses, REMOTE_PROCESSES } = require('../src/remote-process.ts')
const rows = '100\tpts/2\t777\t/opt/codex\n200\tpts/3\t888\t/opt/codex\n300\tpts/4\t999\t/opt/not-codex\n'
function fixture () {
  const session = { open: true, output$: new Subject() }
  let valid = true
  const target = { ssh: { ssh: { openSessionChannel () {} } }, session, valid: () => valid }
  const calls = []
  const run = async (_, script, signal, sink) => {
    calls.push(script)
    if (script === REMOTE_PROCESSES) await sink(Buffer.from(rows))
    else {
      const nonce = /tabby-process;([a-f0-9]+);200/.exec(script)?.[1]
      assert.ok(nonce)
      const proof = `\x1b]777;tabby-process;${nonce};200\x07`
      session.output$.next(Buffer.from(proof.slice(0, 15)))
      session.output$.next(Buffer.from(proof.slice(15)))
    }
  }
  return { target, run, calls, session, invalidate: () => { valid = false } }
}

test('remote native process parsing matches executable basename and returns no argv or credentials', () => {
  assert.deepEqual(parseRemoteProcesses(rows, 'codex').map(x => x.pid), [100, 200])
  assert.throws(() => parseRemoteProcesses(rows, 'codex; id'), /executable name/)
  assert.deepEqual(parseRemoteProcesses('malformed output\n', 'codex'), [])
})

test('independent SSH proof binds the exact pane among multiple agents without terminal input or signals', async () => {
  const f = fixture()
  const proof = await verifyRemoteProcess(f.target, 'codex', undefined, f.run)
  assert.deepEqual(proof, { pid: 200, tty: 'pts/3', started: '888', executable: '/opt/codex' })
  assert.equal(f.calls.length, 2)
  assert.match(f.calls[1], /printf/)
  assert.doesNotMatch(f.calls.join('\n'), /kill|\/fd\/0|cmdline|environ/)
  assert.equal(f.session.output$.observers.length, 0)
  assert.deepEqual(await verifyRemoteProcess(f.target, 'codex', proof, f.run), proof)
})

test('a replaced process, wrong start time or changed connection cannot inherit a previous remote identity', async () => {
  const f = fixture()
  const previous = { pid: 200, tty: 'pts/3', started: 'old', executable: '/opt/codex' }
  assert.equal(await verifyRemoteProcess(f.target, 'codex', previous, f.run), null)
  assert.equal(f.calls.length, 1, 'no challenge is written for a stale PID identity')
  f.invalidate()
  assert.equal(await verifyRemoteProcess(f.target, 'codex', undefined, f.run), null)
})

test('unavailable exec and failed or excessive inspection preserve the agent and return no identity', async () => {
  const f = fixture()
  assert.equal(await verifyRemoteProcess({ ...f.target, ssh: {} }, 'codex', undefined, f.run), null)
  assert.equal(await verifyRemoteProcess(f.target, 'codex', undefined, async () => { throw new Error('exec denied') }), null)
  assert.equal(await verifyRemoteProcess(f.target, 'codex', undefined, async (_, script, signal, sink) => { await sink(Buffer.alloc(32769)) }), null)
  assert.equal(f.session.output$.observers.length, 0)
})

test('real Linux PTY output proof identifies a foreground process without touching its stdin', { skip: process.platform !== 'linux', timeout: 10000 }, async t => {
  const { spawn, execFile } = require('node:child_process')
  const { createInterface } = require('node:readline')
  const { promisify } = require('node:util')
  const python = spawn('python3', ['-u', '-c', `
import os,pty,signal,json,base64
pid,fd=pty.fork()
if pid==0:
 os.execl('/bin/sleep','sleep','30')
def stop(*args):
 try: os.kill(pid,signal.SIGKILL)
 except ProcessLookupError: pass
 os.waitpid(pid,0)
 os._exit(0)
signal.signal(signal.SIGTERM,stop)
print(json.dumps({'pid':pid}),flush=True)
while True:
 try: data=os.read(fd,4096)
 except OSError: break
 print(json.dumps({'data':base64.b64encode(data).decode()}),flush=True)
stop()
`], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(async () => {
    if (python.exitCode === null) { const exited = new Promise(resolve => python.once('close', resolve)); python.kill(); await exited }
  })
  const session = { output$: new Subject() }
  let pid
  const started = new Promise((resolve, reject) => {
    python.once('error', reject)
    createInterface({ input: python.stdout }).on('line', line => {
      const value = JSON.parse(line)
      if (value.pid) { pid = value.pid; resolve() }
      if (value.data) session.output$.next(Buffer.from(value.data, 'base64'))
    })
  })
  await started
  // Wait until exec has replaced the Python child; no input is written to its PTY.
  for (let i = 0; i < 100 && !fs.readlinkSync(`/proc/${pid}/exe`).endsWith('/sleep'); i++) await new Promise(resolve => setTimeout(resolve, 10))
  const target = { ssh: { ssh: { openSessionChannel () {} } }, session, valid: () => python.exitCode === null }
  const run = async (_, script, signal, sink) => {
    const result = await promisify(execFile)('/bin/sh', ['-c', script], { signal, maxBuffer: 32768 })
    await sink(Buffer.from(result.stdout))
  }
  const proof = await verifyRemoteProcess(target, 'sleep', undefined, run)
  assert.equal(proof?.pid, pid)
  assert.match(proof.tty, /^pts\/\d+$/)
  assert.equal(await verifyRemoteProcess(target, 'sleep', { ...proof, started: '0' }, run), null)
})

test('a still-running deleted executable keeps its exact procfs identity and can be verified', async () => {
  const f = fixture()
  const deleted = rows.replace('/opt/codex\n300', '/opt/codex (deleted)\n300')
  const run = async (target, script, signal, sink) => script === REMOTE_PROCESSES ? sink(Buffer.from(deleted)) : f.run(target, script, signal, sink)
  const proof = await verifyRemoteProcess(f.target, 'codex', undefined, run)
  assert.equal(proof.executable, '/opt/codex (deleted)')
  assert.match(f.calls[0], /\/opt\/codex \(deleted\)/)
})

test('a hung SSH channel opener cannot outlive the inspection deadline', { timeout: 6000 }, async () => {
  const f = fixture(), before = Date.now()
  assert.equal(await verifyRemoteProcess(f.target, 'codex', undefined, () => new Promise(() => {})), null)
  assert.ok(Date.now() - before < 5500)
  assert.equal(f.session.output$.observers.length, 0)
})
