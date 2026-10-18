// Exercises the installed app-server locally. Never sends turn/start or model requests.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')

const originalLoad = Module._load
Module._load = function (name, parent, main) {
  if (name === '@angular/core') return { Injectable: () => target => target }
  if (name === 'tabby-core' || name === 'tabby-terminal') return {}
  return originalLoad.call(this, name, parent, main)
}
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, experimentalDecorators: true },
}).outputText, file)
const { CodexService } = require('../src/codex.service.ts')
const { AgentStore } = require('../src/agent-store.ts')
Module._load = originalLoad

async function main () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-context-smoke-'))
  const service = new CodexService()
  service.setContextStore(new AgentStore(path.join(root, 'sessions')))
  const settings = { executable: process.argv[2] || 'codex', cwd: root, model: '', reasoningEffort: '',
    sandbox: 'read-only', approvalPolicy: 'never', threads: {}, tabToolThreads: {} }
  let id
  const unexpectedTurns = []
  service.client.on('event', event => {
    if (event.method === 'turn/started') unexpectedTurns.push({ threadId: event.params.threadId, turnId: event.params.turn.id })
  })
  try {
    await service.connect(settings)
    const context = { sourceThreadId: 'fixture', sourceFingerprint: 'deepseek-fixture', cwd: root,
      messages: [{ role: 'user', content: 'Remember marker TABBY_IMPORT_OK' }, { role: 'assistant', content: 'Remembered.' }],
      turns: [{ id: 'fixture-turn', status: 'completed', items: [
        { id: 'fixture-user', type: 'userMessage', content: [{ type: 'text', text: 'Remember marker TABBY_IMPORT_OK' }] },
        { id: 'fixture-answer', type: 'agentMessage', text: 'Remembered.' },
      ] }], totalTokens: 12,
      goal: { objective: 'Verify imported context without inference', status: 'active', tokenBudget: 100, usedTokens: 12 } }
    id = await service.importContext(context, root, settings)
    assert.equal(await service.resumeThread(id, root, settings), id)
    const exported = await service.exportContext(id)
    assert.deepEqual(exported.messages, context.messages)
    assert.deepEqual(await service.inheritedTurns(id), context.turns)
    assert.equal(exported.goal.objective, context.goal.objective)
    assert.equal(exported.goal.usedTokens, 12)
    assert.equal(exported.goal.tokenBudget, 100)
    assert.equal(unexpectedTurns.length, 0, 'importing context must not automatically start inference')
    console.log('PASS real Codex: import, resume, inherited display history, export and goal continuity')
    console.log('No model requests or tool executions were sent; test thread is archived on exit')
  } finally {
    for (const turn of unexpectedTurns) await service.client.request('turn/interrupt', turn).catch(() => {})
    if (id) await service.client.request('thread/archive', { threadId: id }).catch(() => {})
    service.client.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
