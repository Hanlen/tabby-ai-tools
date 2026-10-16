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
