const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const Module = require('node:module')
const ts = require('typescript')
const { Subject } = require('rxjs')

class FakeTerminal {
  constructor (cwd) {
    this.session = { output$: new Subject(), getWorkingDirectory: async () => cwd }
    this.sessionChanged$ = new Subject()
  }
}
class FakeSplitTab {
  constructor (tabs) { this.tabs = tabs }
  getAllTabs () { return this.tabs }
}

const originalLoad = Module._load
const originalTsLoader = require.extensions['.ts']
Module._load = function (request, parent, isMain) {
  if (request === '@angular/core') return { Injectable: () => target => target }
  if (request === 'tabby-core') return { SplitTabComponent: FakeSplitTab }
  if (request === 'tabby-terminal') return { BaseTerminalTabComponent: FakeTerminal }
  return originalLoad.call(this, request, parent, isMain)
}
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText
  module._compile(output, filename)
}
const { CodexTerminalOutputService } = require('../src/terminal-output.service.ts')
Module._load = originalLoad
require.extensions['.ts'] = originalTsLoader

test('private attachment frames never enter context and wrapped completion hides old payload', () => {
  const terminal = new FakeTerminal('/project'), service = new CodexTerminalOutputService({ tabs: [terminal] })
  service.watch(terminal)
  const release = service.suppress(terminal)
  service.hideAttachmentOutput(terminal, 'TA_0123456789abcdef_DONE')
  terminal.session.output$.next('PRIVATE_BASE64_PAYLOAD')
  assert.equal(service.readSince(terminal, 0, 100).text, '')
  assert.equal(service.isSuppressed(terminal), true)
  release()
  const view = service.sanitizeView(terminal, 'PRIVATE_BASE64_PAYLOAD\nTA_01234567\n89abcdef_DONE:0\n$ ready')
  assert.ok(!view.includes('PRIVATE_BASE64_PAYLOAD')); assert.match(view, /ready/)
  assert.equal(service.sanitizeView(terminal, 'new later output'), 'new later output')
  service.unwatch(terminal)
})

test('an unknown PTY cancellation keeps late payload private until a reliable shell prompt', () => {
  const terminal = new FakeTerminal('/project'), service = new CodexTerminalOutputService({ tabs: [terminal] })
  service.watch(terminal)
  const release = service.suppress(terminal)
  service.hideAttachmentOutput(terminal, 'TA_cancelled_DONE')
  service.holdUntilShellPrompt(terminal, release)
  terminal.session.output$.next('LATE_PRIVATE_BASE64')
  assert.equal(service.readSince(terminal, 0, 100).text, '')
  terminal.session.output$.next('\x1b]133;D;130\x07\x1b]133;A\x07')
  assert.equal(service.isSuppressed(terminal), false)
  terminal.session.output$.next('fresh safe output')
  assert.equal(service.sanitizeView(terminal, 'old truncated screen without footer'), 'fresh safe output')
  terminal.session.closed$ = new Subject()
  const releaseClosed = service.suppress(terminal)
  service.holdUntilShellPrompt(terminal, releaseClosed)
  terminal.session.closed$.next()
  terminal.session.output$.next('PRIVATE_AFTER_CLOSE')
  assert.equal(service.isSuppressed(terminal), true)
  assert.ok(!service.readSince(terminal, 0, 1000).text.includes('PRIVATE_AFTER_CLOSE'))
  service.unwatch(terminal)
})

test('only bound terminals are observed and all watchers must release them', () => {
  const selected = new FakeTerminal('/project')
  const other = new FakeTerminal('/other')
  const service = new CodexTerminalOutputService({ tabs: [selected, other] })
  selected.session.output$.next('before binding')
  assert.equal(service.has(selected), false)
  assert.equal(service.watch(selected), 0)
  service.watch(selected)
  other.session.output$.next('do not capture')
  selected.session.output$.next('\x1b[31mnew output\x1b[0m')
  assert.equal(service.readSince(selected, 0, 100).text, 'new output')
  assert.equal(service.has(other), false)
  service.unwatch(selected)
  selected.session.output$.next(' still watched')
  assert.equal(service.readSince(selected, 10, 100).text, ' still watched')
  service.unwatch(selected)
  assert.equal(service.has(selected), false)
  assert.equal(selected.session.output$.observers.length, 0)
})

test('same-directory recovery binds only an unambiguous terminal', async () => {
  const first = new FakeTerminal('/project')
  const second = new FakeTerminal('/project')
  const app = { tabs: [new FakeSplitTab([first, second])] }
  const service = new CodexTerminalOutputService(app)
  assert.equal(await service.findSource('/project'), undefined)
  app.tabs = [first]
  assert.equal(await service.findSource('/project'), first)
})

test('changing sessions starts a fresh stream and filtered chunks exclude attachment bytes', () => {
  const terminal = new FakeTerminal('/project'), service = new CodexTerminalOutputService({ tabs: [terminal] })
  service.watch(terminal)
  const stream = service.streamId(terminal), chunks = []
  const subscription = service.chunks$.subscribe(chunk => chunks.push(chunk.text))
  terminal.session.output$.next('old')
  const release = service.suppress(terminal)
  terminal.session.output$.next('PRIVATE_PAYLOAD')
  release()
  terminal.session = { output$: new Subject(), getWorkingDirectory: async () => '/project' }
  terminal.sessionChanged$.next(terminal.session)
  assert.notEqual(service.streamId(terminal), stream)
  assert.equal(service.cursor(terminal), 0)
  terminal.session.output$.next('new')
  assert.equal(service.readSince(terminal, 0, 100).text, 'new')
  assert.deepEqual(chunks, ['old', 'new'])
  subscription.unsubscribe(); service.unwatch(terminal)
})
