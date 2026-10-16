const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const Module = require('node:module')
const ts = require('typescript')

const originalLoad = Module._load
const originalTsLoader = require.extensions['.ts']
Module._load = function (request, parent, isMain) {
  if (request === '@angular/core') return { Injectable: () => target => target }
  if (request === './tab-tools') return { TAB_TOOLS: [{ type: 'namespace', name: 'tabby_tabs', tools: [] }] }
  return originalLoad.call(this, request, parent, isMain)
}
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, experimentalDecorators: true } }).outputText
  module._compile(output, filename)
}
const { CodexService } = require('../src/codex.service.ts')
Module._load = originalLoad
require.extensions['.ts'] = originalTsLoader

test('old threads are upgraded and new threads retain Tabby tools on resume', async () => {
  const service = new CodexService()
  const calls = []
  service.client.request = async (method, params) => {
    calls.push({ method, params })
    return { thread: { id: 'tool-thread' } }
  }
  const settings = { model: '', approvalPolicy: 'on-request', sandbox: 'workspace-write', threads: { '/project': 'old-thread' } }
  assert.equal(await service.openThread('/project', settings, 'old-thread'), 'tool-thread')
  assert.equal(calls[0].method, 'thread/start')
  assert.equal(calls[0].params.dynamicTools[0].name, 'tabby_tabs')
  assert.equal(settings.tabToolThreads['/project'], 'tool-thread')
  assert.equal(await service.openThread('/project', settings, 'tool-thread'), 'tool-thread')
  assert.equal(calls[1].method, 'thread/resume')
  assert.equal(calls[1].params.excludeTurns, true)
})

test('session history lists this plugin\'s sessions for the current directory', async () => {
  const service = new CodexService()
  const calls = []
  service.client.request = async (method, params) => {
    calls.push({ method, params })
    return { data: [
      { id: 'plugin-1', cwd: '/project', originator: 'tabby_codex_agent', source: 'vscode', preview: 'A task' },
      { id: 'other-1', cwd: '/project', originator: 'another_app', preview: 'Other task' },
    ], nextCursor: 'next-page' }
  }
  const page = await service.listSessions('/project', 'first-page')
  assert.deepEqual(page.data.map(session => session.id), ['plugin-1'])
  assert.equal(page.nextCursor, 'next-page')
  assert.deepEqual(calls[0], { method: 'thread/list', params: {
    cwd: '/project', cursor: 'first-page', limit: 100, sortKey: 'updated_at', sortDirection: 'desc', sourceKinds: ['cli', 'vscode', 'appServer'],
  } })
})

test('session history skips pages from other clients and retains only Tabby sessions', async () => {
  const service = new CodexService()
  const cursors = []
  service.client.request = async (method, params) => {
    assert.equal(method, 'thread/list')
    cursors.push(params.cursor)
    return params.cursor === null
      ? { data: [{ id: 'cli-session', originator: 'codex_cli_rs' }], nextCursor: 'second' }
      : { data: [{ id: 'tabby-session', originator: 'tabby_codex_agent', source: 'vscode' }], nextCursor: null }
  }
  const page = await service.listSessions('/project')
  assert.deepEqual(page.data.map(session => session.id), ['tabby-session'])
  assert.deepEqual(cursors, [null, 'second'])
  assert.equal(page.nextCursor, null)
})

test('session history rejects repeating cursors instead of looping forever', async () => {
  const service = new CodexService()
  service.client.request = async () => ({ data: [], nextCursor: 'repeat' })
  await assert.rejects(service.listSessions('/project'), /重复分页游标/)
})

test('selected reasoning effort reaches new threads, resumed threads and subsequent turns', async () => {
  const service = new CodexService()
  const calls = []
  service.client.request = async (method, params) => {
    calls.push({ method, params })
    return { thread: { id: 'thread-1' }, turn: { id: 'turn-1' } }
  }
  const settings = { model: 'model-a', reasoningEffort: 'ultra', sandbox: 'workspace-write', approvalPolicy: 'on-request' }
  await service.openThread('/project', settings)
  await service.resumeThread('thread-1', '/project', settings)
  await service.startTurn('thread-1', 'Task', '/project', settings)
  assert.equal(calls[0].params.config.model_reasoning_effort, 'ultra')
  assert.equal(calls[1].params.config.model_reasoning_effort, 'ultra')
  assert.equal(calls[2].params.effort, 'ultra')
  assert.equal(calls[2].params.model, 'model-a')
})

test('full access and user approval are passed to the next turn', async () => {
  const service = new CodexService()
  let params
  service.client.request = async (method, value) => {
    assert.equal(method, 'turn/start')
    params = value
    return { turn: { id: 'turn-1' } }
  }
  await service.startTurn('thread-1', 'Do a task', '/project', {
    sandbox: 'danger-full-access', approvalPolicy: 'on-request', model: '',
  })
  assert.deepEqual(params.sandboxPolicy, { type: 'dangerFullAccess' })
  assert.equal(params.approvalPolicy, 'on-request')
})

test('resolved model and reasoning defaults are tracked per thread and updated by accepted turns', async () => {
  const service = new CodexService()
  service.client.request = async method => method === 'turn/start'
    ? { turn: { id: 'turn-1' } }
    : { thread: { id: method === 'thread/start' ? 'one' : 'two' }, model: 'resolved-default', reasoningEffort: 'high' }
  const settings = { model: '', reasoningEffort: '', sandbox: 'read-only', approvalPolicy: 'never' }
  await service.openThread('/project', settings)
  await service.resumeThread('two', '/project', settings)
  assert.deepEqual(service.getThreadConfiguration('one'), { model: 'resolved-default', reasoningEffort: 'high' })
  await service.startTurn('one', 'Task', '/project', { ...settings, model: 'chosen', reasoningEffort: 'ultra' })
  assert.deepEqual(service.getThreadConfiguration('one'), { model: 'chosen', reasoningEffort: 'ultra' })
  assert.deepEqual(service.getThreadConfiguration('two'), { model: 'resolved-default', reasoningEffort: 'high' })
  service.client.request = async () => { throw new Error('Usage limit exceeded') }
  await assert.rejects(service.startTurn('one', 'Task', '/project', { ...settings, model: 'rejected' }))
  assert.equal(service.getThreadConfiguration('one').model, 'chosen')
})

test('model list includes visible models across pages and chosen model reaches the next turn', async () => {
  const service = new CodexService()
  const calls = []
  service.client.request = async (method, params) => {
    calls.push({ method, params })
    if (method === 'model/list') return params.cursor
      ? { data: [{ model: 'model-b', displayName: 'B', hidden: false }], nextCursor: null }
      : { data: [{ model: 'model-a', displayName: 'A', hidden: false }, { model: 'hidden', hidden: true }], nextCursor: 'page-2' }
    return { turn: { id: 'turn-1' } }
  }
  assert.deepEqual((await service.listModels()).map(model => model.model), ['model-a', 'model-b'])
  await service.startTurn('thread-1', 'Do a task', '/project', { sandbox: 'workspace-write', approvalPolicy: 'on-request', model: 'model-b' })
  assert.equal(calls.at(-1).params.model, 'model-b')
})
