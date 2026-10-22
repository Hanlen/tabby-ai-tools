const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const Module = require('node:module')
const ts = require('typescript')
const { Subject } = require('rxjs')
const load = Module._load, extension = require.extensions['.ts']
Module._load = function (request, ...args) {
  if (request === '@angular/core') return { Injectable: () => target => target }
  if (['tabby-core', 'tabby-terminal', 'tabby-settings'].includes(request)) return {}
  return load.call(this, request, ...args)
}
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.CommonJS, experimentalDecorators: true },
}).outputText, file)
const { AgentBackendFactory } = require('../src/agent-backend.service.ts')
const { CodexService } = require('../src/codex.service.ts')
const { ScheduledTasksService } = require('../src/scheduled-tasks.service.ts')
Module._load = load; require.extensions['.ts'] = extension

test('scheduler uses real Codex connect on an isolated client, current CLI and saved model without disconnecting foreground', async t => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tabby-backend-'))
  const previousWindow = global.window
  global.window = { addEventListener () {}, removeEventListener () {} }
  const settings = { executable: 'old-codex', model: 'chosen-model', reasoningEffort: 'high', approvalPolicy: 'never', sandbox: 'read-only', goalTokenBudget: 0 }
  const config = { ready$: new Subject(), store: { codexAgent: { ...settings, executable: 'new-codex', apiProfiles: [] } } }
  const shared = new CodexService(), calls = [], clients = [], requests = []
  // Only OS process creation and RPC transport are stubbed; connect/close/disconnect are real.
  shared.client.executable = 'new-codex'
  shared.client.ready = Promise.resolve()
  shared.client.connected = true
  shared.client.process = {} // process stub without a PID: no OS signals are sent
  let foregroundDisconnects = 0
  shared.client.on('disconnected', () => foregroundDisconnects++)
  const platform = { getConfigPath: () => path.join(directory, 'config.yaml') }
  const agents = new AgentBackendFactory(config, shared, {}, platform)
  const create = agents.create.bind(agents)
  agents.create = (id, isolated) => {
    assert.equal(isolated, true)
    const backend = create(id, isolated)
    assert.notEqual(backend, shared)
    clients.push(backend.client)
    backend.client.start = async executable => { calls.push(executable); backend.client.connected = true; backend.client.process = {} }
    backend.client.request = async (method, params) => {
      requests.push({ method, params })
      if (method === 'model/list') return { data: [{ model: 'chosen-model' }], nextCursor: null }
      if (method === 'thread/start') return { thread: { id: 'background' } }
      if (method === 'turn/start') {
        setImmediate(() => {
          backend.client.emit('event', { id: 1, method: 'item/tool/call', params: { threadId: 'background', namespace: 'tabby_tasks', tool: 'scheduled_task_finish', arguments: { status: 'completed', evidence: 'verified' } } })
        })
        return { turn: { id: 'turn' } }
      }
      throw new Error('Unexpected RPC ' + method)
    }
    backend.client.respond = () => setImmediate(() => backend.client.emit('event', { method: 'turn/completed', params: { threadId: 'background', turn: { status: 'completed', id: 'turn' } } }))
    return backend
  }
  const service = new ScheduledTasksService(config, platform, agents, { releaseOwner () {} }, { error: (...args) => assert.fail(args.join(' ')) })
  t.after(async () => { service.ngOnDestroy(); global.window = previousWindow; await fs.promises.rm(directory, { recursive: true, force: true }) })
  const task = await service.store.create({ title: 'fixture', instructions: 'verify', scheduleType: 'interval', intervalMinutes: 1 }, '/project', '', settings)
  await service.call('scheduled_task_models', { profileId: '' }, '/project', '', settings)
  await service.runNow(task.id, '/project')
  let record
  for (let i = 0; i < 300; i++) {
    record = (await service.store.read()).runs[0]
    if (record?.finishedAt && !service.runner && !service.preflight) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(record.status, 'completed', record.summary)
  assert.equal((await service.store.read()).tasks[0].enabled, true)
  assert.deepEqual(calls, ['new-codex', 'new-codex']) // discovery is isolated too
  assert.equal(foregroundDisconnects, 0)
  assert.equal(shared.client.isConnected, true)
  assert.ok(clients.every(client => !client.isConnected))
  const thread = requests.find(entry => entry.method === 'thread/start').params
  const turn = requests.find(entry => entry.method === 'turn/start').params
  assert.equal(thread.model, 'chosen-model')
  assert.equal(thread.config.model_reasoning_effort, 'high')
  assert.equal(turn.model, 'chosen-model')
  assert.equal(turn.effort, 'high')
  assert.equal(thread.sandbox, 'read-only')
  assert.equal(settings.executable, 'old-codex')
  assert.equal(config.store.codexAgent.executable, 'new-codex')
})
