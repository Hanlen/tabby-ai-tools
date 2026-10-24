const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const ts = require('typescript')
const original = require.extensions['.ts']
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
}).outputText, filename)
const { TaskMemory, TaskMemoryStore, matchWorkflow, redactMemory, workflowInstructions, workflowNeedsSudo } = require('../src/task-memory.ts')
require.extensions['.ts'] = original

async function fixture (t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tabby-task-memory-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const store = new TaskMemoryStore(root)
  return { root, store, memory: new TaskMemory(store) }
}
async function begin (memory, text = '构建前端项目并检查结果', cwd = '/project', owner = 'thread') {
  await memory.prepare(owner, text, cwd, true)
  return memory.token(owner)
}
function command (memory, token, text = 'pnpm build', owner = 'thread') {
  memory.record(owner, token, 'send_input', { tabId: 'ephemeral-tab-12', text, submit: true, purpose: '构建前端' }, { sent: true, submitted: true, server: localServer })
}
const localServer = { type: 'local', profileId: 'local-shell', serverId: 'local-machine', host: 'workstation', ip: '127.0.0.1', port: 0, username: 'test', cwd: '/project' }
function confirm (memory, token, owner = 'thread') {
  return memory.checkpoint(owner, token, { action: 'confirm_step', step: 1, tabId: 'ephemeral-tab-12', criteria: '构建退出码为 0，产物存在', evidence: '已观察构建成功及产物检查通过' })
}
function read (memory, token, owner = 'thread') {
  memory.record(owner, token, 'read_tab', { tabId: 'ephemeral-tab-12' }, { title: 'development shell', server: localServer, text: 'PRIVATE TERMINAL OUTPUT must never be saved' })
}
async function archive (memory, text, cwd, owner = 'thread') {
  const token = await begin(memory, text, cwd, owner)
  read(memory, token, owner)
  command(memory, token, 'pnpm build', owner)
  read(memory, token, owner)
  confirm(memory, token, owner)
  return memory.finish(owner, token, 'completed', 'complete', '构建完成，已检查结果')
}

test('completed terminal workflows survive restart and reuse only one matching workflow from the same workspace', async t => {
  const { store, memory, root } = await fixture(t)
  const workflow = await archive(memory, '构建前端项目并检查结果', '/project')
  assert.equal(workflow.steps[0].target, 'development shell')
  await archive(memory, '检查数据库的连接状态', '/project', 'second')
  await archive(memory, '构建前端项目并检查结果', '/other-project', 'third')
  const reopened = new TaskMemory(new TaskMemoryStore(root))
  await memory.setAlias(workflow.id, 'task1')
  const suggestion = await reopened.prepare('new-thread', '/task1', '/project')
  assert.equal(suggestion.workflow.id, workflow.id)
  assert.match(suggestion.context, /pnpm build/)
  assert.match(suggestion.context, /重新获取 tab ID/)
  assert.doesNotMatch(suggestion.context, /数据库/)
  assert.equal((await reopened.prepare('x', '构建前端项目并检查结果', '/unknown')).workflow, undefined)
  const serialized = await fs.promises.readFile(path.join(root, 'task-memory.json'), 'utf8')
  assert.doesNotMatch(serialized, /PRIVATE TERMINAL OUTPUT|ephemeral-tab-12/)
  assert.equal((await store.read()).workflows.length, 3)
})

test('failed, interrupted, incomplete and unverified operations are never auto-archived', async t => {
  const { store, memory } = await fixture(t)
  for (const [turn, goal] of [['failed', 'complete'], ['interrupted', 'complete'], ['completed', 'active'], ['completed', 'blocked']]) {
    const token = await begin(memory)
    command(memory, token)
    read(memory, token)
    assert.equal(await memory.finish('thread', token, turn, goal, 'done'), undefined)
  }
  let token = await begin(memory)
  read(memory, token)
  command(memory, token)
  assert.equal(await memory.finish('thread', token, 'completed', 'complete', 'no post-command check'), undefined)
  token = await begin(memory)
  read(memory, token)
  assert.equal(await memory.finish('thread', token, 'completed', 'complete', 'no operation'), undefined)
  assert.deepEqual((await store.read()).workflows, [])
})

test('blocked or merely typed commands do not enter a workflow; repeated polling adds no steps', async t => {
  const { memory } = await fixture(t)
  const token = await begin(memory)
  memory.record('thread', token, 'send_input', { text: 'delete-important-data', submit: true }, { sent: false, blocked: true })
  memory.record('thread', token, 'send_input', { text: 'not-submitted', submit: false }, { sent: true, submitted: false })
  command(memory, token)
  for (let i = 0; i < 100; i++) read(memory, token)
  confirm(memory, token)
  const workflow = await memory.finish('thread', token, 'completed', 'complete', 'done')
  assert.equal(workflow.steps.length, 1)
  assert.equal(workflow.steps[0].command, 'pnpm build')
})

test('interactive input, long commands, credentials and truncated workflows cannot produce incomplete reusable procedures', async t => {
  const { memory, store } = await fixture(t)
  for (const text of ['curl -H "Authorization: Bearer private-value" https://example.com', 'API_KEY="very-secret" deploy', 'sshpass -p password ssh remote', 'x'.repeat(1201)]) {
    const token = await begin(memory)
    command(memory, token, text)
    command(memory, token)
    read(memory, token)
    assert.equal(await memory.finish('thread', token, 'completed', 'complete', 'done'), undefined)
  }
  let token = await begin(memory)
  command(memory, token)
  memory.record('thread', token, 'send_input', { mode: 'stdin', text: 'private-password' }, { sent: true })
  read(memory, token)
  assert.equal(await memory.finish('thread', token, 'completed', 'complete', 'done'), undefined)
  token = await begin(memory)
  for (let i = 0; i < 25; i++) command(memory, token, `echo step-${i}`)
  read(memory, token)
  assert.equal(await memory.finish('thread', token, 'completed', 'complete', 'done'), undefined)
  assert.deepEqual((await store.read()).workflows, [])
})

test('preferences are explicitly scoped, editable, deduplicated and bounded in the model context', async t => {
  const { memory, store } = await fixture(t)
  await memory.addPreference('优先使用中文回答', '')
  await memory.addPreference('优先使用中文回答', '')
  await memory.addPreference('使用 pnpm 构建', '/project')
  await memory.addPreference('只能使用 yarn', '/other')
  const suggestion = await memory.prepare('thread', 'random unmatched task', '/project')
  assert.equal(suggestion.preferences.length, 2)
  assert.match(suggestion.context, /中文|pnpm/)
  assert.doesNotMatch(suggestion.context, /yarn/)
  let data = await store.read()
  await memory.savePreference(data.preferences[1].id, '使用 npm', '/project')
  assert.match((await memory.prepare('thread', 'another task', '/project')).context, /npm/)
  await memory.removePreference(data.preferences[0].id)
  assert.equal((await store.read()).preferences.length, 2)
  await assert.rejects(memory.addPreference('token=private-value', ''), /不含密钥/)
  for (let i = 0; i < 10; i++) await memory.addPreference('偏好-' + i, '/project')
  assert.equal((await memory.prepare('thread', 'unmatched', '/project')).preferences.length, 8)
})

test('manual workflow edits and disablement survive automatic updates and deletion removes matching', async t => {
  const { memory, store } = await fixture(t)
  const first = await archive(memory, '构建前端项目并检查结果', '/project')
  await memory.saveWorkflow(first, '前端构建', first.objective, '先检查分支，再运行 pnpm build，最后核对产物。', false)
  assert.equal((await memory.prepare('thread', first.objective, '/project')).workflow, undefined)
  const updated = await archive(memory, first.objective, '/project')
  assert.equal(updated.successes, 2)
  assert.equal(updated.enabled, false)
  assert.match(updated.instructions, /先检查分支/)
  await memory.saveWorkflow(updated, updated.title, updated.objective, updated.instructions, true)
  await memory.setAlias(first.id, 'build')
  assert.equal((await memory.prepare('thread', '/build', '/project')).workflow.id, first.id)
  await memory.used(first.id)
  assert.equal((await store.read()).workflows[0].uses, 1)
  await memory.removeWorkflow(first.id)
  assert.equal((await memory.prepare('thread', first.objective, '/project')).workflow, undefined)
})

test('a stale tool completion cannot contaminate a new task and duplicate finish calls archive only once', async t => {
  const { memory, store } = await fixture(t)
  const old = await begin(memory, 'old task')
  const current = await begin(memory, 'build current project')
  command(memory, old, 'stale-command')
  command(memory, current)
  read(memory, current)
  confirm(memory, current)
  await Promise.all([memory.finish('thread', current, 'completed', 'complete', 'done'), memory.finish('thread', current, 'completed', 'complete', 'done')])
  const data = await store.read()
  assert.equal(data.workflows.length, 1)
  assert.equal(data.workflows[0].successes, 1)
  assert.doesNotMatch(JSON.stringify(data), /stale-command/)
  await begin(memory)
  memory.clearRuns()
  assert.equal(memory.token('thread'), undefined)
})

test('separate store instances serialize concurrent updates and leave no partial files or locks', async t => {
  const { root, store } = await fixture(t)
  const others = Array.from({ length: 5 }, () => new TaskMemory(new TaskMemoryStore(root)))
  await Promise.all(others.map((memory, i) => memory.addPreference('preference-' + i, '/project')))
  assert.equal((await store.read()).preferences.length, 5)
  assert.deepEqual(await fs.promises.readdir(root), ['task-memory.json'])
  if (process.platform !== 'win32') assert.equal((await fs.promises.stat(path.join(root, 'task-memory.json'))).mode & 0o777, 0o600)
})

test('corrupt and oversized libraries fail visibly and are never overwritten', async t => {
  const { root, store } = await fixture(t)
  const file = path.join(root, 'task-memory.json')
  await fs.promises.writeFile(file, '{broken')
  await assert.rejects(store.update(data => data.preferences.push({ id: 'x', text: 'test', cwd: '' })))
  assert.equal(await fs.promises.readFile(file, 'utf8'), '{broken')
  assert.deepEqual((await fs.promises.readdir(root)).sort(), ['task-memory.json'])
  await fs.promises.writeFile(file, 'x'.repeat(2 * 1024 * 1024 + 1))
  await assert.rejects(store.read(), /过大/)
})

test('only explicit aliases match enabled workflows in the current workspace', async t => {
  const { memory, store } = await fixture(t)
  const first = await archive(memory, 'build frontend', '/project')
  const second = await archive(memory, 'deploy frontend', '/project', 'second')
  await memory.setAlias(first.id, '/Task1')
  await assert.rejects(memory.setAlias(second.id, 'task1'), /已使用/)
  for (const alias of ['remember', 'model', 'bad name', 'x;id', '1abc']) await assert.rejects(memory.setAlias(first.id, alias))
  const workflows = (await store.read()).workflows
  assert.equal(matchWorkflow(workflows, '/TASK1', '/project').id, first.id)
  for (const query of ['build frontend', '/task1 extra', '/task']) assert.equal(matchWorkflow(workflows, query, '/project'), undefined)
  assert.equal(matchWorkflow(workflows, '/task1', '/other'), undefined)
  assert.equal(matchWorkflow(workflows.map(w => ({ ...w, enabled: false })), '/task1', '/project'), undefined)
  assert.equal(workflowInstructions({ instructions: 'manual procedure', steps: [] }), 'manual procedure')
  assert.equal(workflowNeedsSudo({ instructions: 'sudo systemctl restart app', steps: [] }), true)
  assert.equal(workflowNeedsSudo({ instructions: '', steps: [{ command: 'sudo ls' }] }), true)
})

test('redaction covers common secret formats, quoted values and URL credentials', () => {
  for (const input of ['API_KEY="secret-value"', 'token: secret-value', '--password secret-value', 'Bearer secret-value', 'https://user:secret-value@example.com', 'sk-' + 'a'.repeat(30), '-----BEGIN PRIVATE KEY-----\nsecret-value\n-----END PRIVATE KEY-----']) {
    const result = redactMemory(input)
    assert.doesNotMatch(result, /secret-value|sk-aaaa/)
    assert.match(result, /已隐藏/)
  }
})

test('resuming an unrecorded task cannot archive only its final fragment as a complete workflow', async t => {
  const { memory, store } = await fixture(t)
  await memory.prepare('restored-thread', '继续检查结果', '/project', false)
  assert.equal(memory.token('restored-thread'), undefined)
  command(memory, undefined, 'check-final-output', 'restored-thread')
  read(memory, undefined, 'restored-thread')
  assert.equal(await memory.finish('restored-thread', undefined, 'completed', 'complete', 'done'), undefined)
  assert.deepEqual((await store.read()).workflows, [])
})

test('ordinary requests never start recording', async t => {
  const { memory } = await fixture(t)
  await memory.prepare('ordinary', 'build frontend', '/project')
  assert.equal(memory.token('ordinary'), undefined)
})

const serverA = { type: 'ssh', profileId: 'ssh-db', serverId: 'db-machine', host: '10.0.0.10', ip: '10.0.0.10', port: 22, username: 'deploy', cwd: '/srv/database' }
const serverB = { ...serverA, profileId: 'ssh-app', serverId: 'app-machine', host: '10.0.0.20', ip: '10.0.0.20', cwd: '/srv/application' }
function observed (memory, token, tabId, server, extra = {}) {
  memory.record('thread', token, 'read_tab', { tabId }, { title: server.host + ' shell', text: 'observed output', server, ...extra })
}
function submit (memory, token, tabId, commandText, extra = {}) {
  const args = { tabId, text: commandText, submit: true, ...extra }
  memory.beforeTool('thread', token, 'send_input', args)
  memory.record('thread', token, 'send_input', args, { sent: true, submitted: true })
}
function checkpoint (memory, token, tabId, step, extra = {}) {
  return memory.checkpoint('thread', token, { action: 'confirm_step', tabId, step, criteria: 'service healthy', evidence: 'Observed health endpoint returned 200 after command completion', ...extra })
}

test('multi-server steps persist IP, stable IDs, paths, order and fresh per-terminal verification', async t => {
  const { memory, store } = await fixture(t)
  const token = await begin(memory, 'check DB then application')
  observed(memory, token, 'ephemeral-A', serverA)
  observed(memory, token, 'ephemeral-B', serverB)
  submit(memory, token, 'ephemeral-A', 'systemctl restart service')
  assert.throws(() => submit(memory, token, 'ephemeral-B', 'systemctl restart service'), /尚未确认/)
  assert.throws(() => checkpoint(memory, token, 'ephemeral-A', 1), /新结果/)
  observed(memory, token, 'ephemeral-B', serverB)
  assert.throws(() => checkpoint(memory, token, 'ephemeral-B', 1), /执行终端/)
  observed(memory, token, 'ephemeral-A', serverA, { commandState: 'running' })
  assert.throws(() => checkpoint(memory, token, 'ephemeral-A', 1), /仍在运行/)
  observed(memory, token, 'ephemeral-A', serverA, { commandState: 'prompt' })
  checkpoint(memory, token, 'ephemeral-A', 1)
  submit(memory, token, 'ephemeral-B', 'systemctl restart service')
  observed(memory, token, 'ephemeral-B', serverB, { commandState: 'prompt' })
  checkpoint(memory, token, 'ephemeral-B', 2)
  const workflow = await memory.finish('thread', token, 'completed', 'complete', 'both healthy')
  assert.equal(workflow.steps.length, 2, 'identical commands on different servers are distinct steps')
  assert.deepEqual(workflow.steps.map(s => s.server), [serverA, serverB])
  assert.deepEqual(workflow.steps.map(s => s.dependsOn), [[], [1]])
  assert.ok(workflow.steps.every(s => s.verification.confirmedAt))
  assert.doesNotMatch(JSON.stringify((await store.read()).workflows[0]), /ephemeral-A|ephemeral-B|observed output/)
})

test('same-server verification commands do not advance the dependency chain or reuse earlier reads', async t => {
  const { memory } = await fixture(t)
  const token = await begin(memory)
  observed(memory, token, 'A', serverA)
  submit(memory, token, 'A', 'systemctl restart app')
  observed(memory, token, 'A', serverA)
  assert.throws(() => submit(memory, token, 'B', 'curl health', { verificationFor: 1 }), /执行终端/)
  submit(memory, token, 'A', 'curl -f localhost/health', { verificationFor: 1 })
  assert.throws(() => checkpoint(memory, token, 'A', 1), /新结果/)
  observed(memory, token, 'A', serverA)
  checkpoint(memory, token, 'A', 1)
  const workflow = await memory.finish('thread', token, 'completed', 'complete', 'healthy')
  assert.equal(workflow.steps.length, 1)
  assert.deepEqual(workflow.steps[0].verificationCommands, ['curl -f localhost/health'])
})

test('alias execution rejects wrong server/path, weaker checks and parallel command submission', async t => {
  const { memory } = await fixture(t)
  const workflow = { objective: 'restart app', cwd: '/project', steps: [{ command: 'restart', server: serverA, verification: { criteria: 'service healthy' } }] }
  memory.beginExecution('thread', workflow)
  const token = memory.token('thread')
  observed(memory, token, 'wrong', serverB)
  assert.throws(() => submit(memory, token, 'wrong', 'restart'), /不一致/)
  observed(memory, token, 'A', { ...serverA, cwd: '/wrong' })
  assert.throws(() => submit(memory, token, 'A', 'restart'), /不一致/)
  observed(memory, token, 'A', serverA)
  memory.beforeTool('thread', token, 'send_input', { tabId: 'A', text: 'restart', submit: true })
  assert.throws(() => memory.beforeTool('thread', token, 'send_input', { tabId: 'A', text: 'restart twice', submit: true }), /并行/)
  memory.record('thread', token, 'send_input', { tabId: 'A', text: 'restart', submit: true }, { sent: true, submitted: true })
  observed(memory, token, 'A', serverA)
  assert.throws(() => checkpoint(memory, token, 'A', 1, { criteria: 'input sent' }), /验收条件/)
  checkpoint(memory, token, 'A', 1)
  assert.throws(() => submit(memory, token, 'A', 'extra action'), /所有步骤/)
  assert.equal(await memory.finish('thread', token, 'completed', 'complete', 'done'), undefined, 'executing an alias does not archive a second workflow')
})

test('unknown remote identity requires explicit observed binding and paths refresh on later reads', async t => {
  const { memory } = await fixture(t)
  const token = await begin(memory)
  observed(memory, token, 'A', { ...serverA, host: 'database.internal', ip: '', cwd: '' })
  assert.throws(() => memory.checkpoint('thread', token, { action: 'bind_target', tabId: 'A', evidence: 'unknown' }), /操作路径/)
  submit(memory, token, 'A', 'pwd; hostname -I', { verificationFor: 0 })
  observed(memory, token, 'A', { ...serverA, host: 'database.internal', ip: '', cwd: '' })
  const bound = memory.checkpoint('thread', token, { action: 'bind_target', tabId: 'A', evidence: 'Observed server identity and /srv/database', target: serverA })
  assert.deepEqual(bound.server, serverA)
  submit(memory, token, 'A', 'restart')
  observed(memory, token, 'A', serverA)
  checkpoint(memory, token, 'A', 1)
  const workflow = await memory.finish('thread', token, 'completed', 'complete', 'done')
  assert.deepEqual(workflow.steps[0].server, serverA)
  assert.equal(workflow.steps.length, 1, 'initial identity probes are not task steps')
})
