const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const Module = require('node:module')
const { EventEmitter } = require('node:events')
const { AsyncSubject, Subject } = require('rxjs')
const ts = require('typescript')

const originalLoad = Module._load
const originalTsLoader = require.extensions['.ts']
Module._load = function (request, parent, isMain) {
  if (request === '@angular/core') return { Injectable: () => target => target }
  if (request === 'tabby-core') return {}
  return originalLoad.call(this, request, parent, isMain)
}
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, experimentalDecorators: true } }).outputText
  module._compile(output, filename)
}
const { CodexRuntimeService } = require('../src/codex-runtime.service.ts')
Module._load = originalLoad
require.extensions['.ts'] = originalTsLoader

function setup (t) {
  const window = new EventTarget()
  t.mock.method(global, 'setTimeout', (callback, delay) => {
    const timer = { callback, delay }
    timers.add(timer)
    return timer
  })
  t.mock.method(global, 'clearTimeout', timer => timers.delete(timer))
  const previousWindow = global.window
  global.window = window
  const timers = new Set()
  const config = { ready$: new AsyncSubject(), changed$: new Subject(), store: { codexAgent: { executable: 'codex' } } }
  const calls = []
  const notifications = []
  const client = new EventEmitter()
  client.close = () => { calls.push('close'); client.emit('disconnected', new Error('closed')) }
  const codex = { client, connect: async settings => { calls.push(settings.executable); client.emit('connected') } }
  const runtime = new CodexRuntimeService(config, codex, { error: (...args) => notifications.push(args) })
  t.after(() => {
    runtime.ngOnDestroy()
    if (previousWindow === undefined) delete global.window
    else global.window = previousWindow
  })
  const ready = () => { config.ready$.next(true); config.ready$.complete() }
  const tick = async () => {
    const timer = timers.values().next().value
    assert.ok(timer, 'Expected a reconnect timer')
    timers.delete(timer)
    timer.callback()
    await new Promise(resolve => setImmediate(resolve))
    return timer.delay
  }
  return { runtime, window, config, calls, notifications, client, codex, timers, ready, tick }
}

test('plugin startup waits for configuration and starts once without opening a panel', async t => {
  const env = setup(t)
  env.runtime.start()
  env.runtime.start()
  assert.deepEqual(env.calls, [])
  env.ready()
  assert.deepEqual(env.calls, ['codex'])
  env.config.changed$.next()
  assert.deepEqual(env.calls, ['codex'])
  env.config.store.codexAgent.executable = '/custom/codex'
  env.config.changed$.next()
  assert.deepEqual(env.calls, ['codex', '/custom/codex'])
  env.runtime.ngOnDestroy()
  env.config.changed$.next()
  assert.deepEqual(env.calls, ['codex', '/custom/codex', 'close'])
  assert.equal(env.timers.size, 0)
})

test('startup failures retry with capped backoff and report once until recovery', async t => {
  const env = setup(t)
  env.codex.connect = async () => { env.calls.push('failed'); throw new Error('CLI missing') }
  env.runtime.start()
  env.ready()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(env.notifications.length, 1)
  assert.match(env.notifications[0][1], /CLI missing/)
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    assert.equal(await env.tick(), delay)
    assert.equal(env.notifications.length, 1)
    assert.equal(env.timers.size, 1)
  }
  env.codex.connect = async () => { env.calls.push('recovered'); env.client.emit('connected') }
  await env.tick()
  assert.equal(env.timers.size, 0)
  env.client.emit('disconnected', new Error('crash'))
  assert.equal(await env.tick(), 1000)
  assert.equal(env.calls.at(-1), 'recovered')
})

test('window unload cancels retries, closes the server and removes all listeners', async t => {
  const env = setup(t)
  env.runtime.start()
  env.ready()
  env.client.emit('disconnected', new Error('crash'))
  assert.equal(env.timers.size, 1)
  env.window.dispatchEvent(new Event('unload'))
  assert.equal(env.timers.size, 0)
  assert.equal(env.client.listenerCount('connected'), 0)
  assert.equal(env.client.listenerCount('disconnected'), 0)
  env.runtime.ngOnDestroy()
  env.runtime.start()
  assert.deepEqual(env.calls, ['codex', 'close'])
})

test('destroying the plugin before configuration is ready prevents a late spawn', t => {
  const env = setup(t)
  env.runtime.start()
  env.runtime.ngOnDestroy()
  env.ready()
  assert.deepEqual(env.calls, ['close'])
})

test('an in-flight startup failure after destruction does not report or restart', async t => {
  const env = setup(t)
  let reject
  env.codex.connect = () => new Promise((resolve, failure) => { reject = failure })
  env.runtime.start()
  env.ready()
  env.runtime.ngOnDestroy()
  reject(new Error('late failure'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(env.notifications.length, 0)
  assert.equal(env.timers.size, 0)
})
