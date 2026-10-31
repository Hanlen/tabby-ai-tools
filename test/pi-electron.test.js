const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { EventEmitter, once } = require('node:events')
const { PassThrough } = require('node:stream')
const ts = require('typescript')

function fixture (t, autoExit = true) {
  const owner = new EventEmitter()
  owner.isDestroyed = () => false
  const child = new EventEmitter()
  child.stdout = new PassThrough(); child.stderr = new PassThrough()
  child.postMessage = message => messages.push(message)
  child.kill = () => { killed++; if (autoExit) setImmediate(() => child.emit('exit', 0)); return true }
  const messages = []; let killed = 0, options, entry
  const electron = { app: { isReady: () => true }, utilityProcess: { fork: (file, _args, opts) => { entry = file; options = opts; return child } }, webContents: { fromId: id => id === 7 ? owner : undefined } }
  const filename = path.resolve(__dirname, '../runtime/pi/electron-host.cts')
  const load = Module._load
  const compiled = new Module(filename, module)
  compiled.filename = filename; compiled.paths = module.paths
  Module._load = function (request, parent, main) { return request === 'electron' ? electron : load.call(this, request, parent, main) }
  try { compiled._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText, filename) }
  finally { Module._load = load }
  const host = compiled.exports
  const bridge = host.fork(7)
  t.after(() => child.emit('exit', 0))
  return { host, bridge, child, owner, messages, get killed () { return killed }, get options () { return options }, get entry () { return entry } }
}

test('Electron Pi bridge uses the packaged sidecar and acknowledges completed IPC before exit', async t => {
  const f = fixture(t)
  assert.match(f.entry, /sidecar\.mjs$/)
  assert.equal(f.options.stdio, 'pipe')
  assert.equal(f.options.env.NODE_OPTIONS, '')
  assert.equal(f.options.env.NODE_PATH, '')
  let output = ''
  f.bridge.stdout.on('data', chunk => { output += chunk })
  f.bridge.stdin.write('{"type":"init"}\n')
  assert.deepEqual(f.messages, ['{"type":"init"}'])
  f.child.emit('message', '{"type":"done","text":"verified"}')
  assert.equal(JSON.parse(output).text, 'verified')
  assert.equal(f.messages.at(-1), '{"type":"shutdown"}')
  const closed = once(f.bridge, 'close')
  f.child.emit('exit', 0)
  await closed
  assert.equal(f.owner.listenerCount('destroyed'), 0)
})

test('Electron Pi cancellation waits for the utility process exit', async t => {
  const f = fixture(t, false)
  let completed = false
  const stopping = f.bridge.terminate().then(() => { completed = true })
  await Promise.resolve()
  assert.equal(f.killed, 1)
  assert.equal(completed, false)
  f.child.emit('exit', 0)
  await stopping
  assert.equal(completed, true)
})

test('destroying the owner or renderer terminates its Pi utility process', async t => {
  for (const event of ['destroyed', 'render-process-gone']) {
    const f = fixture(t)
    const closed = once(f.bridge, 'close')
    f.owner.emit(event)
    await closed
    assert.equal(f.killed, 1)
    assert.equal(f.owner.listenerCount('render-process-gone'), 0)
  }
})
