// Uses the actual plugin transport and the user's existing Codex login.
// Initialization is local. --stream sends one short model request.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { once } = require('node:events')
const { parseArgs } = require('node:util')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  }).outputText, filename)
}
const { CodexClient } = require('../src/codex-client.ts')
const { codexEnvironment } = require('../src/codex-executable.ts')
const { values } = parseArgs({ options: {
  executable: { type: 'string', default: '' },
  'without-path': { type: 'boolean', default: false },
  stream: { type: 'boolean', default: false },
  model: { type: 'string' },
} })

async function main () {
  const original = { ...process.env }
  const client = new CodexClient()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby real codex smoke-'))
  let timer
  let threadId
  let turnId
  try {
    if (values['without-path']) {
      for (const key of Object.keys(process.env)) if (key.toLowerCase() === 'path') delete process.env[key]
      process.env.PATH = ''
    }
    process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = 'tabby_smoke_parent_must_not_leak'
    process.env.codex_internal_originator_override = 'tabby_smoke_parent_must_not_leak'
    assert.ok(!Object.keys(codexEnvironment()).some(key => key.toUpperCase() === 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE'))
    await client.connect(values.executable)
    console.log(`Platform: ${process.platform}; PATH removed: ${values['without-path']}; CLI: ${client.process.spawnfile}`)
    console.log('PASS actual Codex initialize/initialized via plugin clientInfo and cleaned child environment')
    if (!values.stream) {
      console.log('SKIP model streaming (add --stream to send a real model request using your login)')
      return
    }
    let deltas = 0
    let text = ''
    let completed
    const done = new Promise((resolve, reject) => {
      completed = { resolve, reject }
      timer = setTimeout(() => reject(new Error('No completed streamed turn within 180 seconds')), 180000)
    })
    // Handle early failures without an unhandled rejection while turn/start awaits.
    done.catch(() => {})
    client.on('disconnected', error => completed.reject(error))
    client.on('event', message => {
      if (message.id !== undefined) {
        client.respondError(message.id, 'Smoke test does not permit tools or approval requests')
        return
      }
      if (message.params?.threadId !== threadId) return
      if (message.method === 'item/agentMessage/delta') {
        deltas++
        text += message.params.delta || ''
      }
      if (message.method === 'turn/completed') {
        if (message.params.turn?.status === 'completed') completed.resolve()
        else completed.reject(new Error(`Turn status: ${message.params.turn?.status}; ${JSON.stringify(message.params.turn?.error || {})}`))
      }
      if (message.method === 'error' && !message.params.willRetry) completed.reject(new Error(JSON.stringify(message.params.error)))
    })
    const thread = await client.request('thread/start', {
      cwd, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true,
      ...(values.model ? { model: values.model } : {}),
    })
    threadId = thread.thread.id
    // Recent app-server versions expose originator directly in Thread metadata.
    if (thread.thread.originator !== undefined) assert.equal(thread.thread.originator, 'tabby_codex_agent')
    const turn = await client.request('turn/start', {
      threadId, cwd, approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      input: [{ type: 'text', text: 'Reply with exactly TABBY_CODEX_STREAM_OK. Do not use any tools.' }],
    })
    turnId = turn.turn.id
    await done
    assert.ok(deltas > 0, 'No item/agentMessage/delta notifications received')
    assert.ok(text.includes('TABBY_CODEX_STREAM_OK'), 'Model did not return the smoke marker')
    console.log(`PASS actual model streaming: ${deltas} JSONL delta notification(s), completed turn, marker received`)
    turnId = undefined
  } finally {
    clearTimeout(timer)
    if (turnId && client.isConnected) await client.request('turn/interrupt', { threadId, turnId }).catch(() => {})
    const child = client.process
    const closed = child ? once(child, 'close') : Promise.resolve()
    client.close()
    await closed
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]
    Object.assign(process.env, original)
    fs.rmSync(cwd, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(`FAIL ${error.message}`); process.exitCode = 1 })
