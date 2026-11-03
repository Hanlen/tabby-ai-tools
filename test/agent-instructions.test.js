const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const load = Module._load
Module._load = function (name, parent, main) {
  if (name === '@angular/core') return { Injectable: () => x => x, Component: () => x => x }
  if (name === 'tabby-core' || name === 'tabby-terminal') return {}
  if (name === 'tabby-settings') return { SettingsTabProvider: class {} }
  if (/\.(pug|css)$/.test(name)) return ''
  return load.call(this, name, parent, main)
}
require.extensions['.ts'] = (m, file) => m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, experimentalDecorators: true } }).outputText, file)
const { resolveInstructions, validateInstructionsSnapshot, instructionsText } = require('../src/agent-instructions.ts')
const { AgentStore, profileFingerprint } = require('../src/agent-store.ts')
const { ApiAgent } = require('../src/api-agent.ts')
const { CodexService } = require('../src/codex.service.ts')
const { CodexSettingsComponent } = require('../src/settings.ts')
Module._load = load

async function directory (t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tabby instructions '))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  return root
}
const profile = () => ({ id: 'fixture', name: 'Fixture', provider: 'custom', baseUrl: 'http://localhost:1/v1', apiFormat: 'chat-completions', model: 'fixture', thinking: 'default', reasoningEffort: '', maxIterations: 0, maxOutputTokens: 512, threads: {} })
const settings = () => ({ executable: 'codex', model: '', reasoningEffort: '', approvalPolicy: 'never', sandbox: 'read-only', threads: {}, tabToolThreads: {}, defaultInstructions: { mode: 'inline', text: 'global rule' } })

test('instruction sources honor inheritance, explicit disable, BOM, UTF-8, limits and unreadable files', async t => {
  const root = await directory(t), file = path.join(root, '中文 AGENTS.md')
  await fs.promises.writeFile(file, '\uFEFFUse a harmless fixture.')
  const snapshot = await resolveInstructions({ mode: 'file', path: file })
  assert.equal(snapshot.text, 'Use a harmless fixture.'); assert.equal(snapshot.source, file); assert.ok(snapshot.modifiedAt)
  assert.equal((await resolveInstructions(undefined, { mode: 'inline', text: 'default' })).text, 'default')
  assert.equal((await resolveInstructions({ mode: 'none' }, { mode: 'inline', text: 'default' })).text, '')
  assert.equal((await resolveInstructions({ mode: 'inline', text: 'override' }, { mode: 'inline', text: 'default' })).text, 'override')
  await fs.promises.writeFile(file, Buffer.from([0xff, 0xfe]))
  await assert.rejects(resolveInstructions({ mode: 'file', path: file }), /UTF-8/)
  await fs.promises.writeFile(file, 'x'.repeat(32769))
  await assert.rejects(resolveInstructions({ mode: 'file', path: file }), /32 KiB/)
  await assert.rejects(resolveInstructions({ mode: 'inline', text: 'x'.repeat(32769) }), /32 KiB/)
  await assert.rejects(resolveInstructions({ mode: 'file', path: root }), /regular/)
  await assert.rejects(resolveInstructions({ mode: 'file', path: 'relative/AGENTS.md' }), /absolute/)
  await fs.promises.unlink(file)
  await assert.rejects(resolveInstructions({ mode: 'file', path: file }), /ENOENT/)
  assert.throws(() => validateInstructionsSnapshot({ ...snapshot, text: 'tampered' }), /Invalid/)
})

test('API sessions freeze custom instructions across file changes, missing files, restart and history listing', async t => {
  const root = await directory(t), file = path.join(root, 'AGENTS.md'), store = new AgentStore(path.join(root, 'store')), p = profile(), config = settings()
  p.instructions = { mode: 'file', path: file }
  await fs.promises.writeFile(file, 'frozen-rule')
  const agent = new ApiAgent(p, store, async () => ''), systems = []
  agent.createAdapter = async () => ({ generate: async (_messages, system) => { systems.push(system); return { text: 'done', messages: [{ role: 'assistant', content: 'done' }], tools: [], inputTokens: 0, outputTokens: 0, totalTokens: 0 } } })
  const id = await agent.openThread(root, config)
  await fs.promises.unlink(file)
  await agent.resumeThread(id, root, config)
  const finished = new Promise(resolve => agent.once('event', function observe (event) { if (event.method === 'turn/completed') resolve(event); else agent.once('event', observe) }))
  await agent.startTurn(id, 'answer', root, config); await finished
  assert.match(systems[0], /frozen-rule/); assert.equal(systems[0].split('frozen-rule').length, 2)
  const restarted = new ApiAgent({ ...p, instructions: { mode: 'inline', text: 'new-rule' } }, store, async () => '')
  assert.equal(await restarted.resumeThread(id, root, config), id)
  assert.equal((await store.load(id)).instructions.text, 'frozen-rule')
  assert.equal((await restarted.listSessions(root)).data[0].id, id)
  assert.equal(profileFingerprint(p), profileFingerprint(restarted.profile))
  await assert.rejects(agent.openThread(root, config), /ENOENT/)
  agent.close(); restarted.close()
})

test('Codex app-server receives one custom layer and uses persisted snapshots on resume, rejecting cross-space IDs', async t => {
  const root = await directory(t), store = new AgentStore(root), service = new CodexService(), calls = [], config = settings()
  service.sessionSpace = { engine: 'codex', key: 'private-fixture', native: path.join(root, 'native') }
  service.setContextStore(store)
  service.client.request = async (method, params) => { calls.push({ method, params }); return method === 'thread/list' ? { data: [{ id: 'owned', originator: 'tabby_codex_agent' }, { id: 'foreign', originator: 'tabby_codex_agent' }] } : { thread: { id: 'owned' } } }
  const id = await service.openThread(root, config)
  config.defaultInstructions.text = 'changed-default'
  await service.resumeThread(id, root, config)
  const start = calls.find(c => c.method === 'thread/start').params.developerInstructions
  const resume = calls.find(c => c.method === 'thread/resume').params.developerInstructions
  assert.match(start, /global rule/); assert.equal(start.split('global rule').length, 2)
  assert.match(resume, /global rule/); assert.doesNotMatch(resume, /changed-default/)
  assert.deepEqual((await service.listSessions(root)).data.map(s => s.id), [id])
  const count = calls.length
  await assert.rejects(service.resumeThread('foreign', root, config), /another space/)
  await assert.rejects(service.resumeThread(id, path.dirname(root), config), /workspace/)
  assert.equal(calls.length, count, 'foreign sessions must not reach the app-server')
})

test('instruction UI supports drafts, failure rollback, preview and explicit disable without model calls', async t => {
  const root = await directory(t), config = { store: { codexAgent: { ...settings(), apiProfiles: [] } }, save: async () => {} }
  const component = new CodexSettingsComponent(config, {}, { run: fn => fn() })
  component.instructionDraft.mode = 'inline'; component.instructionDraft.text = 'connection rule'; component.instructionChanged()
  assert.equal(config.store.codexAgent.codexInstructions, undefined)
  await component.previewInstructions(); assert.equal(component.instructionPreview.text, 'connection rule')
  await component.saveInstructions(); assert.deepEqual(config.store.codexAgent.codexInstructions, { mode: 'inline', text: 'connection rule' })
  component.instructionDraft.text = 'unsaved'
  config.save = async () => { throw new Error('disk') }
  await component.saveInstructions()
  assert.equal(config.store.codexAgent.codexInstructions.text, 'connection rule')
  assert.equal(component.instructionDraft.text, 'unsaved')
  component.discardInstructions(); assert.equal(component.instructionDraft.text, 'connection rule')
  component.instructionDraft.mode = 'file'; component.instructionDraft.path = path.join(root, 'missing.md')
  config.save = async () => {}
  await component.saveInstructions(); assert.equal(config.store.codexAgent.codexInstructions.mode, 'file')
  await component.previewInstructions(); assert.match(component.instructionNotice, /ENOENT/)
  component.ngOnDestroy()
})

test('Codex private sessions reject concurrent turns and reuse a completed context handoff without inference', async t => {
  const root = await directory(t), store = new AgentStore(root), config = settings(), calls = []
  const make = () => {
    const service = new CodexService()
    service.sessionSpace = { engine: 'codex', key: 'space', native: path.join(root, 'native') }
    service.setContextStore(store)
    service.client.request = async (method, params) => {
      calls.push(method)
      if (method === 'turn/start') return { turn: { id: 'turn' } }
      return { thread: { id: 'native', status: { type: 'idle' } } }
    }
    return service
  }
  const a = make(), b = make()
  const context = { sourceThreadId: 'source', sourceSpace: 'system:codex', sourceFingerprint: 'codex', cwd: root, messages: [{ role: 'user', content: 'preserve this context' }], turns: [], totalTokens: 0 }
  const id = await a.importContext(context, root, config)
  assert.equal(await b.importContext(context, root, config), id)
  assert.equal(calls.filter(method => method === 'thread/start').length, 1)
  assert.equal(calls.includes('turn/start'), false)
  await a.startTurn(id, 'start', root, config)
  await assert.rejects(b.startTurn(id, 'duplicate', root, config), /another window/)
  a.client.emit('event', { method: 'turn/completed', params: { threadId: id, turn: { id: 'turn' } } })
  await new Promise(resolve => setTimeout(resolve, 30))
  await b.startTurn(id, 'next', root, config)
  b.client.emit('event', { method: 'turn/completed', params: { threadId: id, turn: { id: 'turn' } } })
  await new Promise(resolve => setTimeout(resolve, 30))
})
