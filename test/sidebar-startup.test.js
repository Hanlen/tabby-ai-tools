const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const { AsyncSubject, Subject } = require('rxjs')
const ts = require('typescript')

class SplitTabComponent {}
class BaseTerminalTabComponent {}
const originalLoad = Module._load
const originalTsLoader = require.extensions['.ts']
Module._load = function (request, parent, isMain) {
  if (request === '@angular/core') return { Injectable: () => target => target }
  if (request === 'tabby-core') return { ToolbarButtonProvider: class {}, ConfigProvider: class {}, SplitTabComponent }
  if (request === 'tabby-terminal') return { BaseTerminalTabComponent }
  if (request === './sidebar.service') return {}
  return originalLoad.call(this, request, parent, isMain)
}
require.extensions['.ts'] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, experimentalDecorators: true },
  }).outputText
  module._compile(output, filename)
}
const { CodexToolbarButtonProvider } = require('../src/button.ts')
const { CodexConfigProvider } = require('../src/config.ts')
Module._load = originalLoad
require.extensions['.ts'] = originalTsLoader

const flush = () => new Promise(resolve => setTimeout(resolve, 15))
const ready = subject => { subject.next(true); subject.complete() }

function setup (t, settings = {}, appReady = new AsyncSubject(), configReady = new AsyncSubject()) {
  const calls = []
  const app = { ready$: appReady, activeTab: null }
  const config = { ready$: configReady, store: { codexAgent: settings } }
  const sidebar = { isVisible: false, show: (...args) => { calls.push(args); sidebar.isVisible = true } }
  const provider = new CodexToolbarButtonProvider(app, config, sidebar, { error: (...args) => assert.fail(args.join(' ')) })
  t.after(() => provider.ngOnDestroy())
  return { app, config, sidebar, provider, calls }
}

test('startup opening defaults on for new and existing configs without the setting', async t => {
  assert.equal(new CodexConfigProvider().defaults.codexAgent.openOnStartup, true)
  for (const settings of [new CodexConfigProvider().defaults.codexAgent, {}]) {
    const f = setup(t, settings)
    ready(f.app.ready$)
    ready(f.config.ready$)
    assert.deepEqual(f.calls, [], 'mounting waits until the ready view has rendered')
    await flush()
    assert.deepEqual(f.calls, [[path.resolve(os.homedir()), undefined]])
  }
})

test('an explicit opt-out preserves manual opening', async t => {
  const f = setup(t, { openOnStartup: false })
  ready(f.app.ready$)
  ready(f.config.ready$)
  await flush()
  assert.deepEqual(f.calls, [])
  f.provider.provide()[0].click()
  await flush()
  assert.deepEqual(f.calls, [[path.resolve(os.homedir()), undefined]])
})

for (const first of ['app', 'config']) {
  test(`startup waits for both readiness signals when ${first} is ready first`, async t => {
    const f = setup(t, { openOnStartup: true, cwd: process.cwd() })
    ready(f[first].ready$)
    await flush()
    assert.deepEqual(f.calls, [])
    ready(f[first === 'app' ? 'config' : 'app'].ready$)
    assert.deepEqual(f.calls, [], 'mounting waits until the ready view has rendered')
    await flush()
    assert.deepEqual(f.calls, [[path.resolve(process.cwd()), undefined]])
  })
}

test('late provider creation still opens after completed readiness signals', async t => {
  const appReady = new AsyncSubject()
  const configReady = new AsyncSubject()
  ready(appReady)
  ready(configReady)
  const f = setup(t, { openOnStartup: true }, appReady, configReady)
  await flush()
  assert.equal(f.calls.length, 1)
})

test('startup uses the focused terminal directory and binds it as the source', async t => {
  const f = setup(t, { openOnStartup: true })
  const terminal = new BaseTerminalTabComponent()
  terminal.session = { getWorkingDirectory: async () => os.tmpdir() }
  f.app.activeTab = Object.assign(new SplitTabComponent(), { getFocusedTab: () => terminal })
  ready(f.config.ready$)
  ready(f.app.ready$)
  await flush()
  assert.deepEqual(f.calls, [[path.resolve(os.tmpdir()), terminal]])
})

test('a fixed directory takes priority without querying the terminal', async t => {
  const f = setup(t, { openOnStartup: true, cwd: process.cwd() })
  const terminal = new BaseTerminalTabComponent()
  terminal.session = { getWorkingDirectory: () => assert.fail('fixed directory must take priority') }
  f.app.activeTab = terminal
  ready(f.config.ready$)
  ready(f.app.ready$)
  await flush()
  assert.deepEqual(f.calls, [[path.resolve(process.cwd()), terminal]])
})

test('a failed terminal directory lookup falls back to the home directory', async t => {
  const f = setup(t, { openOnStartup: true })
  const terminal = new BaseTerminalTabComponent()
  terminal.session = { getWorkingDirectory: async () => { throw new Error('terminal closed') } }
  f.app.activeTab = terminal
  ready(f.config.ready$)
  ready(f.app.ready$)
  await flush()
  assert.deepEqual(f.calls, [[path.resolve(os.homedir()), terminal]])
})

test('startup does not replace an already visible sidebar', async t => {
  const f = setup(t, { openOnStartup: true })
  f.provider.provide()[0].click()
  await flush()
  assert.equal(f.calls.length, 1)
  ready(f.config.ready$)
  ready(f.app.ready$)
  await flush()
  assert.equal(f.calls.length, 1)
})

test('later readiness or settings changes never reopen a manually hidden sidebar', async t => {
  const f = setup(t, { openOnStartup: true }, new Subject(), new Subject())
  f.config.ready$.next(true)
  f.app.ready$.next()
  await flush()
  assert.equal(f.calls.length, 1)
  f.sidebar.isVisible = false
  f.config.store.codexAgent.openOnStartup = false
  f.config.ready$.next(true)
  f.config.store.codexAgent.openOnStartup = true
  f.app.ready$.next()
  await flush()
  assert.equal(f.calls.length, 1)
})

test('changing the disabled setting after startup applies only to the next launch', async t => {
  const f = setup(t, { openOnStartup: false }, new Subject(), new Subject())
  f.config.ready$.next(true)
  f.app.ready$.next()
  await flush()
  f.config.store.codexAgent.openOnStartup = true
  f.config.ready$.next(true)
  f.app.ready$.next()
  await flush()
  assert.deepEqual(f.calls, [])
})

for (const phase of ['before-ready', 'scheduled', 'directory-lookup']) {
  test(`destruction during ${phase} cancels startup opening`, async t => {
    const f = setup(t, { openOnStartup: true })
    let finishDirectory
    if (phase === 'directory-lookup') {
      f.app.activeTab = Object.assign(new BaseTerminalTabComponent(), {
        session: { getWorkingDirectory: () => new Promise(resolve => { finishDirectory = resolve }) },
      })
    }
    if (phase !== 'before-ready') {
      ready(f.config.ready$)
      ready(f.app.ready$)
    }
    if (phase === 'directory-lookup') {
      await flush()
      assert.equal(typeof finishDirectory, 'function')
    }
    f.provider.ngOnDestroy()
    if (phase === 'before-ready') {
      ready(f.config.ready$)
      ready(f.app.ready$)
    }
    finishDirectory?.(os.tmpdir())
    await flush()
    assert.deepEqual(f.calls, [])
  })
}
