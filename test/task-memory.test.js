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
const { TaskMemory, TaskMemoryStore, matchWorkflow, redactMemory, workflowInstructions } = require('../src/task-memory.ts')
require.extensions['.ts'] = original

async function fixture (t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tabby-task-memory-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const store = new TaskMemoryStore(root)
  return { root, store, memory: new TaskMemory(store) }
}
async function begin (memory, text = '构建前端项目并检查结果', cwd = '/project', owner = 'thread') {
  await memory.prepare(owner, text, cwd)
  return memory.token(owner)
}
function command (memory, token, text = 'pnpm build', owner = 'thread') {
  memory.record(owner, token, 'send_input', { tabId: 'ephemeral-tab-12', text, submit: true, purpose: '构建前端' }, { sent: true, submitted: true })
}
function read (memory, token, owner = 'thread') {
  memory.record(owner, token, 'read_tab', { tabId: 'ephemeral-tab-12' }, { title: 'development shell', text: 'PRIVATE TERMINAL OUTPUT must never be saved' })
}
async function archive (memory, text, cwd, owner = 'thread') {
  const token = await begin(memory, text, cwd, owner)
  read(memory, token, owner)
  command(memory, token, 'pnpm build', owner)
  read(memory, token, owner)
  return memory.finish(owner, token, 'completed', 'complete', '构建完成，已检查结果')
}

test('completed terminal workflows survive restart and reuse only one matching workflow from the same workspace', async t => {
  const { store, memory, root } = await fixture(t)
  const workflow = await archive(memory, '构建前端项目并检查结果', '/project')
  assert.equal(workflow.steps[0].target, 'development shell')
  await archive(memory, '检查数据库的连接状态', '/project', 'second')
  await archive(memory, '构建前端项目并检查结果', '/other-project', 'third')
  const reopened = new TaskMemory(new TaskMemoryStore(root))
  const suggestion = await reopened.prepare('new-thread', '请帮我构建前端项目并检查结果', '/project')
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
  command(memory, token)
  for (let i = 0; i < 100; i++) read(memory, token)
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
  assert.equal((await memory.prepare('thread', first.objective, '/project')).workflow.id, first.id)
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

test('Chinese and English matching is conservative and ignores disabled or unrelated workflows', () => {
  const workflow = { id: '1', objective: 'deploy frontend staging release-a', cwd: '/project', enabled: true, successes: 1, completedAt: 1 }
  assert.equal(matchWorkflow([workflow], 'please deploy frontend staging release-b', '/project'), workflow)
  assert.equal(matchWorkflow([workflow], 'delete backend database', '/project'), undefined)
  assert.equal(matchWorkflow([{ ...workflow, enabled: false }], workflow.objective, '/project'), undefined)
  const chinese = { ...workflow, objective: '构建前端项目并检查结果' }
  assert.equal(matchWorkflow([chinese], '请帮我构建前端项目并检查结果', '/project'), chinese)
  assert.equal(matchWorkflow([chinese], '检查数据库连接状态', '/project'), undefined)
  assert.equal(workflowInstructions({ instructions: 'manual procedure', steps: [] }), 'manual procedure')
})

test('redaction covers common secret formats, quoted values and URL credentials', () => {
  for (const input of ['API_KEY="secret-value"', 'token: secret-value', '--password secret-value', 'Bearer secret-value', 'https://user:secret-value@example.com', 'sk-' + 'a'.repeat(30), '-----BEGIN PRIVATE KEY-----\nsecret-value\n-----END PRIVATE KEY-----']) {
    const result = redactMemory(input)
    assert.doesNotMatch(result, /secret-value|sk-aaaa/)
    assert.match(result, /已隐藏/)
  }
})

test('local matching recognizes common shell task synonyms without a model call', () => {
  const workflow = { id: 'deploy', objective: '部署前端服务到预发环境', cwd: '/project', enabled: true, successes: 2, completedAt: 1 }
  assert.equal(matchWorkflow([workflow], '请帮我发布前端服务到预发环境', '/project'), workflow)
  assert.equal(matchWorkflow([workflow], '删除前端服务的生产数据库', '/project'), undefined)
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

test('matching does not confuse opposite operations on the same service or project', () => {
  const base = { id: 'workflow', cwd: '/project', enabled: true, successes: 1, completedAt: 1 }
  for (const [previous, current] of [
    ['构建前端项目', '重启前端项目'], ['部署前端服务', '删除前端服务'],
    ['启动后台服务', '停止后台服务'], ['清理前端构建目录', '构建前端目录'],
  ]) assert.equal(matchWorkflow([{ ...base, objective: previous }], current, '/project'), undefined)
})

test('negated operations are not treated as requests to repeat an affirmative workflow', () => {
  const workflow = { id: 'restart', objective: '重启后台服务', cwd: '/project', enabled: true, successes: 1, completedAt: 1 }
  assert.equal(matchWorkflow([workflow], '不要重启后台服务', '/project'), undefined)
  assert.equal(matchWorkflow([{ ...workflow, objective: 'restart backend service' }], 'do not restart backend service', '/project'), undefined)
})
