const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const { EventEmitter } = require('node:events')
const { Subject, BehaviorSubject } = require('rxjs')
const ts = require('typescript')

class Terminal {
  constructor () {
    this.title = 'project'
    this.session = { output$: new Subject(), getWorkingDirectory: async () => '/project' }
    this.sessionChanged$ = new Subject()
  }
}
const originalLoad = Module._load
const originalTsLoader = require.extensions['.ts']
Module._load = function (request, parent, isMain) {
  if (request === '@angular/core') return { Injectable: () => target => target, Component: () => target => target, Input: () => () => {}, Output: () => () => {}, ViewChild: () => () => {}, EventEmitter: class {} }
  if (request === 'tabby-core') return { ConfigService: class {}, SplitTabComponent: class {} }
  if (request === 'tabby-terminal') return { BaseTerminalTabComponent: Terminal }
  if (['./codex.service', './tab-tools', './agent-backend.service'].includes(request)) return {}
  if (request.endsWith('.pug') || request.endsWith('.css')) return ''
  return originalLoad.call(this, request, parent, isMain)
}
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, experimentalDecorators: true },
}).outputText, filename)
const { CodexPanelComponent } = require('../src/codex-panel.component.ts')
const { CodexTerminalOutputService } = require('../src/terminal-output.service.ts')
const { retryDeadline, retryDuration, isRateLimitError } = require('../src/turn-retry.ts')
const { setLanguage, formatDateTime } = require('../src/i18n.ts')
Module._load = originalLoad
require.extensions['.ts'] = originalTsLoader

function fixture (t) {
  setLanguage('en')
  const terminal = new Terminal()
  const output = new CodexTerminalOutputService({ tabs: [terminal] })
  const started = [], steered = [], interrupted = [], released = []
  const backend = { client: new EventEmitter(), setGoal: async () => {}, getGoal: async () => ({ status: 'active' }),
    startTurn: async (...args) => { started.push(args); return `turn-${started.length}` },
    steer: async (...args) => steered.push(args), interrupt: async (...args) => interrupted.push(args),
  }
  const controls$ = new BehaviorSubject([])
  const panel = new CodexPanelComponent({ store: { codexAgent: {} } }, backend, { run: fn => fn() }, output,
    { controls$, releaseOwner: id => released.push(id) })
  Object.assign(panel, { threadId: 'thread', cwd: '/project', connected: true, loading: false, sourceTerminal: terminal })
  panel.reconnect = async () => true
  t.after(() => panel.ngOnDestroy())
  const event = (method, params = {}) => backend.client.emit('event', { method, params: { threadId: 'thread', ...params } })
  const retry = (error = { message: '429 Too Many Requests' }, turnId = panel.turnId) => event('error', { turnId, error, willRetry: true })
  return { panel, terminal, output, started, steered, interrupted, released, backend, event, retry }
}

async function start (f) {
  await f.panel.ngOnInit()
  f.panel.prompt = 'continue the workflow'
  await f.panel.send()
}

test('high-frequency echo stays in the bounded terminal buffer without steering or new model turns', async t => {
  const f = fixture(t)
  await start(f)
  f.event('turn/started', { turn: { id: 'turn-1' } })
  for (let i = 0; i < 5000; i++) f.terminal.session.output$.next(`echo ${i}\r\n`)
  // Run beyond the former 700ms flush interval, including during backend backoff.
  f.retry({ message: '429 Too Many Requests', additionalDetails: 'retrying in 436 seconds' })
  const waiting = f.panel.retryState
  for (let i = 0; i < 5000; i++) f.terminal.session.output$.next(`progress ${i}\r\n`)
  await new Promise(resolve => setTimeout(resolve, 750))
  assert.equal(f.started.length, 1)
  assert.deepEqual(f.steered, [])
  assert.equal(f.panel.retryState, waiting)
  assert.equal(f.output.updates$.observers.length, 0, 'the panel must not listen for output to inject')
  assert.equal(f.output.readSince(f.terminal, 0, 2000).text.length, 2000, 'on-demand output remains available')
  assert.equal(f.panel.busy, true)
  assert.equal(f.panel.turnId, 'turn-1')
  assert.deepEqual(f.released, [])
})

test('retry notices use explicit backend timing, deduplicate errors and survive progress and command output', async t => {
  const f = fixture(t)
  await start(f)
  const now = Date.now()
  const error = { message: 'upstream unavailable', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 429 } }, additionalDetails: 'Retrying in 445 seconds.' }
  f.retry(error)
  assert.ok(f.panel.retryState.retryAt >= now + 445000)
  assert.match(f.panel.retryNotice, /Next retry:/)
  assert.ok(f.panel.retryNotice.includes(formatDateTime(f.panel.retryState.retryAt)))
  assert.equal(f.panel.retryState.rateLimited, true)
  f.retry(error)
  assert.equal(f.panel.entries.filter(entry => entry.kind === 'system').length, 1)
  f.event('agent/progress', { phase: 'waiting' })
  f.event('item/commandExecution/outputDelta', { itemId: 'old-command', delta: 'STEP2_EXTRACT_OK' })
  assert.equal(f.panel.status, '请求限流，等待后台自动重试')
  assert.ok(f.panel.retryState)
  f.panel.prompt = 'try again'
  await f.panel.send()
  assert.equal(f.panel.prompt, 'try again')
  assert.equal(f.started.length, 1)
  assert.deepEqual(f.steered, [])
  f.event('item/agentMessage/delta', { itemId: 'answer', delta: 'Recovered' })
  assert.equal(f.panel.retryState, undefined)
  assert.equal(f.panel.sendNotice, '')
  assert.equal(f.panel.status, '正在执行任务…')
})

test('missing retry timing is explicit and never inferred from account reset time', async t => {
  const f = fixture(t)
  await start(f)
  f.panel.statusRateLimits = { primary: { usedPercent: 100, resetsAt: 2000000000 }, secondary: null }
  f.retry()
  assert.equal(f.panel.retryState.retryAt, null)
  assert.match(f.panel.retryNotice, /did not provide/)
  assert.match(f.panel.sendNotice, /429 本身不能证明长期额度耗尽/)
  f.event('item/started', { item: { id: 'new-call', type: 'dynamicToolCall' } })
  assert.equal(f.panel.retryNotice, '')
})

test('stopping interrupts backend retry and ignores late errors from the cancelled or older turn', async t => {
  const f = fixture(t)
  await start(f)
  f.retry()
  await f.panel.stop()
  assert.deepEqual(f.interrupted, [['thread', 'turn-1']])
  assert.equal(f.panel.retryState, undefined)
  f.retry()
  assert.equal(f.panel.retryState, undefined)
  f.event('turn/completed', { turn: { id: 'turn-1', status: 'interrupted' } })
  assert.equal(f.panel.busy, false)
  assert.equal(f.panel.turnId, '')
  assert.match(f.panel.status, /终端的命令可能仍在运行/)
  await f.panel.continueTask()
  f.retry({ message: '429 Too Many Requests' }, 'turn-1')
  f.event('turn/completed', { turn: { id: 'turn-1', status: 'interrupted' } })
  assert.equal(f.panel.retryState, undefined)
  assert.equal(f.panel.turnId, 'turn-2')
  assert.equal(f.panel.busy, true)
})

test('failed cancellation keeps the retry visible and reports the failure', async t => {
  const f = fixture(t)
  await start(f)
  f.retry()
  f.backend.interrupt = async () => { throw new Error('offline') }
  await f.panel.stop()
  assert.ok(f.panel.retryState)
  assert.equal(f.panel.busy, true)
  assert.match(f.panel.connectionError, /offline/)
  f.retry()
  assert.ok(f.panel.retryState)
})

test('disconnect clears retry presentation without claiming terminal completion', async t => {
  const f = fixture(t)
  await start(f)
  f.retry()
  f.backend.client.emit('disconnected', new Error('connection lost'))
  assert.equal(f.panel.retryNotice, '')
  assert.equal(f.panel.busy, false)
  assert.match(f.panel.status, /任务尚未确认完成/)
})

test('retry parsing accepts only explicit durations and classifies structured HTTP 429', () => {
  for (const [text, ms] of [['Retrying in 436 seconds', 436000], ['try again after 2 minutes', 120000], ['retry in 204s', 204000], ['retry in 250 ms', 250], ['retry in 250 milliseconds', 250], ['retrying in 0.5 seconds', 500]]) {
    assert.equal(retryDeadline({ additionalDetails: text }, 1000), 1000 + ms)
  }
  for (const message of ['429 Too Many Requests', 'reset in 60 seconds', 'retry in -3 seconds', 'retry in Infinity seconds', 'retrying soon']) assert.equal(retryDeadline({ message }), null)
  assert.equal(isRateLimitError({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } } }), true)
  assert.equal(isRateLimitError({ message: 'service unavailable', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } } }), false)
})

test('retry clocks refresh without backend calls, retain total waiting time and clean up on recovery', async t => {
  const f = fixture(t)
  await start(f)
  let updates = 0
  f.panel.changeDetector = { detectChanges: () => updates++ }
  f.retry({ message: '429 Too Many Requests; retrying in 436 seconds' })
  f.panel.retryState.startedAt = Date.now() - 65000
  assert.match(f.panel.retryNotice, /Waited: 01:0[56]/)
  assert.match(f.panel.retryNotice, /Until backend retry estimate: 07:1[56]/)
  const timer = f.panel.retryTimer
  const startedAt = f.panel.retryState.startedAt
  f.retry({ message: '429 Too Many Requests; retrying in 204 seconds' })
  assert.equal(f.panel.retryState.startedAt, startedAt)
  assert.equal(f.panel.retryTimer, timer, 'a repeated error must not create another UI clock')
  const before = updates
  await new Promise(resolve => setTimeout(resolve, 1050))
  assert.ok(updates > before, 'the visible clock advances without another event or click')
  assert.equal(f.started.length, 1)
  assert.deepEqual(f.steered, [])
  f.panel.retryState.retryAt = Date.now() - 1000
  assert.match(f.panel.retryNotice, /estimated time has arrived/)
  assert.doesNotMatch(f.panel.retryNotice, /-00:/)
  f.event('item/agentMessage/delta', { itemId: 'answer', delta: 'Recovered' })
  assert.equal(f.panel.retryTimer, undefined)
  assert.equal(f.panel.retryNotice, '')
})

test('retry UI clock is cleared when its panel is destroyed', async t => {
  const f = fixture(t)
  await start(f)
  f.retry()
  assert.ok(f.panel.retryTimer)
  f.panel.ngOnDestroy()
  assert.equal(f.panel.retryTimer, undefined)
  assert.equal(f.panel.retryState, undefined)
  for (const [ms, expected] of [[0, '00:00'], [-1000, '00:00'], [1500, '00:02'], [436000, '07:16']]) assert.equal(retryDuration(ms), expected)
})
