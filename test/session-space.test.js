const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const ts = require('typescript')
const Module = require('node:module')
const original = Module._load
Module._load = function (name, parent, main) {
  if (name === '@angular/core') return { Injectable: () => x => x, Component: () => x => x }
  if (name === 'tabby-core' || name === 'tabby-terminal') return {}
  if (name === 'tabby-settings') return { SettingsTabProvider: class {} }
  if (/\.(css|pug)$/.test(name)) return ''
  return original.call(this, name, parent, main)
}
require.extensions['.ts'] = (m, file) => m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, experimentalDecorators: true } }).outputText, file)
const { sessionSpaceConfig, resolveSessionSpace, privateSpaceConfig, prepareSessionSpace, initializeNativeAuth, sessionEnvironment, nativeLoginCommand, spaceThreads } = require('../src/session-space.ts')
const { CodexClient } = require('../src/codex-client.ts')
const { AgentStore } = require('../src/agent-store.ts')
const { ClaudeCodeAgent, claudeCodeProfile } = require('../src/claude-code-agent.ts')
const { CodexSettingsComponent } = require('../src/settings.ts')
Module._load = original
const config = () => ({ executable: 'codex', model: '', reasoningEffort: '', cwd: '', approvalPolicy: 'never', sandbox: 'read-only', threads: {}, tabToolThreads: {}, claudeThreads: {} })
async function temporary (t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tabby space '))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  return root
}
async function launcher (root, name, source) {
  const script = path.join(root, name + '.cjs')
  await fs.promises.writeFile(script, source)
  const exe = path.join(root, process.platform === 'win32' ? name + '.cmd' : name)
  await fs.promises.writeFile(exe, process.platform === 'win32' ? `@"${process.execPath}" "${script}" %*\r\n` : `#!${process.execPath}\nrequire(${JSON.stringify(script)})\n`, { mode: 0o700 })
  return exe
}

test('unused engines get stable private spaces; legacy references and explicit choices retain their scope', async t => {
  const root = await temporary(t), settings = config()
  assert.equal(sessionSpaceConfig(settings, 'codex').mode, 'tabby')
  assert.deepEqual(sessionSpaceConfig(settings, 'codex'), sessionSpaceConfig(config(), 'codex'))
  assert.notDeepEqual(sessionSpaceConfig(settings, 'codex'), sessionSpaceConfig(settings, 'claude-code'))
  settings.tabToolThreads[root] = 'legacy'
  assert.equal(sessionSpaceConfig(settings, 'codex').mode, 'system')
  assert.equal(sessionSpaceConfig(settings, 'claude-code').mode, 'tabby')
  const space = resolveSessionSpace(root, 'codex', privateSpaceConfig('codex'))
  settings.cliSessionSpaces = { codex: privateSpaceConfig('codex') }
  assert.equal(sessionSpaceConfig(settings, 'codex').mode, 'tabby')
  spaceThreads(settings, 'codex', space)[root] = 'private'
  assert.equal(settings.tabToolThreads[root], 'legacy')
  assert.equal(settings.spaceThreads[space.key][root], 'private')
  await prepareSessionSpace(space); await prepareSessionSpace(space)
  const manifest = JSON.parse(await fs.promises.readFile(path.join(space.root, 'manifest.json'), 'utf8'))
  assert.deepEqual(manifest, { version: 1, engine: 'codex', spaceId: space.key })
  await assert.rejects(prepareSessionSpace({ ...space, engine: 'claude-code' }), /another connection/)
  assert.throws(() => resolveSessionSpace(undefined, 'codex', privateSpaceConfig('codex')), /data directory/)
})

test('owned environment and login commands isolate storage without changing parent variables or leaking API credentials', async t => {
  const root = await temporary(t), space = resolveSessionSpace(root, 'codex', privateSpaceConfig('codex'))
  const inherited = { CODEX_HOME: 'system', codex_sqlite_home: 'outside', OPENAI_API_KEY: 'not-copied', HTTPS_PROXY: 'https://proxy.invalid' }
  const env = sessionEnvironment(space, inherited)
  assert.equal(env.CODEX_HOME, space.native); assert.equal(env.CODEX_SQLITE_HOME, space.native)
  assert.equal(env.codex_sqlite_home, undefined); assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(inherited.CODEX_HOME, 'system'); assert.equal(env.HTTPS_PROXY, inherited.HTTPS_PROXY)
  const claude = resolveSessionSpace(root, 'claude-code', privateSpaceConfig('claude-code'))
  const clean = sessionEnvironment(claude, { CLAUDE_CONFIG_DIR: 'outside', ANTHROPIC_API_KEY: 'secret', CLAUDE_CODE_USE_VERTEX: '1' })
  assert.equal(clean.CLAUDE_CONFIG_DIR, claude.native); assert.equal(clean.ANTHROPIC_API_KEY, undefined); assert.equal(clean.CLAUDE_CODE_USE_VERTEX, undefined)
  const cmd = nativeLoginCommand(space, "/tmp/it's a cli", false)
  assert.match(cmd, /--device-auth/); assert.match(cmd, /sqlite_home=/); assert.match(cmd, /'\\''/)
  assert.doesNotMatch(cmd, /not-copied/)
  const ps = nativeLoginCommand(claude, "C:\\it's a cli\\claude.exe", true)
  assert.match(ps, /\$env:CLAUDE_CONFIG_DIR/); assert.match(ps, /it''s/); assert.match(ps, /'auth' 'login'/)
})

test('an empty private Codex home inherits only the ChatGPT cache, once and with private permissions', async t => {
  const root = await temporary(t), home = path.join(root, 'user'), source = path.join(home, '.codex')
  await fs.promises.mkdir(source, { recursive: true })
  const cache = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'fixture-access', refresh_token: 'fixture-refresh' } })
  await fs.promises.writeFile(path.join(source, 'auth.json'), cache)
  await fs.promises.writeFile(path.join(source, 'history.jsonl'), 'system-history')
  await fs.promises.writeFile(path.join(source, 'config.toml'), 'system-config')
  const space = resolveSessionSpace(root, 'codex', privateSpaceConfig('codex'))
  await prepareSessionSpace(space)
  const copied = await Promise.all(Array.from({ length: 4 }, () => initializeNativeAuth(space, {}, { home })))
  assert.equal(copied.filter(Boolean).length, 1)
  const target = path.join(space.native, 'auth.json')
  assert.equal(await fs.promises.readFile(target, 'utf8'), cache)
  assert.deepEqual((await fs.promises.readdir(space.native)).sort(), ['.tabby-codex-auth-import', 'auth.json'])
  if (process.platform !== 'win32') assert.equal((await fs.promises.stat(target)).mode & 0o777, 0o600)
  await fs.promises.writeFile(target, 'space-local-login')
  assert.equal(await initializeNativeAuth(space, {}, { home }), false)
  assert.equal(await fs.promises.readFile(target, 'utf8'), 'space-local-login')
  assert.equal(await fs.promises.readFile(path.join(source, 'auth.json'), 'utf8'), cache)
})

test('login initialization honors the discovered Codex home and leaves missing or non-ChatGPT caches alone', async t => {
  const root = await temporary(t), source = path.join(root, 'custom home')
  const space = resolveSessionSpace(root, 'codex', privateSpaceConfig('codex'))
  await prepareSessionSpace(space)
  await fs.promises.mkdir(source)
  const env = { CODEX_HOME: source, OPENAI_API_KEY: 'must-not-import' }
  assert.equal(await initializeNativeAuth(space, env, { home: root }), false)
  for (const cache of ['invalid fixture-private-data', 'null', JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'fixture-key' }), JSON.stringify({ tokens: {} })]) {
    await fs.promises.writeFile(path.join(source, 'auth.json'), cache)
    assert.equal(await initializeNativeAuth(space, env, { home: root }), false)
  }
  const cache = JSON.stringify({ tokens: { access_token: 'fixture-access' } })
  await fs.promises.writeFile(path.join(source, 'auth.json'), cache)
  assert.equal(await initializeNativeAuth(resolveSessionSpace(root, 'codex', { mode: 'system' }), env, { home: root }), false)
  assert.equal(await initializeNativeAuth(resolveSessionSpace(root, 'claude-code', privateSpaceConfig('claude-code')), env, { home: root }), false)
  assert.deepEqual(await fs.promises.readdir(space.native), [])
  assert.equal(await initializeNativeAuth(space, { CODEX_HOME: '"~/custom home"' }, { home: root }), true)
  assert.equal(await fs.promises.readFile(path.join(space.native, 'auth.json'), 'utf8'), cache)
})

for (const engine of ['claude-code']) {
  test(`${engine}: explicit recovery replaces expired credentials without changing the source or history`, async t => {
    const root = await temporary(t), source = path.join(root, 'original CLI directory')
    const space = resolveSessionSpace(root, engine, privateSpaceConfig(engine))
    const filename = '.credentials.json'
    const env = { CLAUDE_CONFIG_DIR: source }
    const cache = { claudeAiOauth: { accessToken: 'new-fixture-token', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3600000 } }
    await fs.promises.mkdir(source)
    await fs.promises.writeFile(path.join(source, filename), JSON.stringify(cache))
    await prepareSessionSpace(space)
    await fs.promises.writeFile(path.join(space.native, filename), 'old-fixture-token')
    await fs.promises.writeFile(path.join(space.native, 'history.jsonl'), 'private-history')
    assert.equal(await initializeNativeAuth(space, env), false)
    assert.equal(await initializeNativeAuth(space, env, { replaceExisting: true }), true)
    assert.equal(await fs.promises.readFile(path.join(space.native, filename), 'utf8'), JSON.stringify(cache))
    assert.equal(await fs.promises.readFile(path.join(source, filename), 'utf8'), JSON.stringify(cache))
    assert.equal(await fs.promises.readFile(path.join(space.native, 'history.jsonl'), 'utf8'), 'private-history')
    await fs.promises.unlink(path.join(source, filename))
    assert.equal(await initializeNativeAuth(space, env, { replaceExisting: true }), false)
    await fs.promises.writeFile(path.join(source, filename), 'invalid-fixture-secret')
    assert.equal(await initializeNativeAuth(space, env, { replaceExisting: true }), false)
    assert.equal(await fs.promises.readFile(path.join(space.native, filename), 'utf8'), JSON.stringify(cache))
    assert.deepEqual((await fs.promises.readdir(space.native)).sort(), [filename, 'history.jsonl'].sort())
  })
}

function fixtureLogin (day, { user = 'same-user', account = 'same-workspace', owner = 'original-grant', expired = false } = {}) {
  const claims = { 'https://api.openai.com/auth': { chatgpt_user_id: user }, exp: Math.floor(Date.now() / 1000) + (expired ? -60 : 3600), jti: day }
  return { auth_mode: 'chatgpt', tokens: { access_token: 'jwt.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.fixture',
    refresh_token: 'fixture-refresh-' + day, login_owner_id: owner, account_id: account }, last_refresh: `2026-01-0${day}T00:00:00Z` }
}

test('automatic Codex recovery requires a newer system cache for the imported user and workspace', async t => {
  const root = await temporary(t), source = path.join(root, 'original CLI directory')
  const space = resolveSessionSpace(root, 'codex', privateSpaceConfig('codex'))
  const target = path.join(space.native, 'auth.json'), system = path.join(source, 'auth.json')
  const env = { CODEX_HOME: source }, retry = { replaceExisting: true, automatic: true }
  await fs.promises.mkdir(source)
  await prepareSessionSpace(space)
  await fs.promises.writeFile(system, JSON.stringify(fixtureLogin(1)))
  assert.equal(await initializeNativeAuth(space, env), true)
  // Codex can rotate the private refresh token while retaining login ownership.
  await fs.promises.writeFile(target, JSON.stringify(fixtureLogin(2)))
  for (const invalid of [fixtureLogin(1), fixtureLogin(3, { user: 'another-user' }), fixtureLogin(3, { account: 'another-workspace' }), fixtureLogin(3, { expired: true })]) {
    await fs.promises.writeFile(system, JSON.stringify(invalid))
    assert.equal(await initializeNativeAuth(space, env, retry), false)
    assert.deepEqual(JSON.parse(await fs.promises.readFile(target, 'utf8')), fixtureLogin(2))
  }
  const newest = fixtureLogin(3, { owner: 'system-new-grant' })
  await fs.promises.writeFile(system, JSON.stringify(newest))
  assert.equal(await initializeNativeAuth(space, env, retry), true)
  assert.equal(await initializeNativeAuth(space, env, retry), false)
  await fs.promises.writeFile(target, JSON.stringify(fixtureLogin(2, { owner: 'independent-private-login' })))
  assert.equal(await initializeNativeAuth(space, env, retry), false)
  assert.deepEqual(JSON.parse(await fs.promises.readFile(system, 'utf8')), newest)
})

test('real app-server transport separates two persistent stores and restarts when the selected space changes', async t => {
  const root = await temporary(t)
  const source = path.join(root, 'shell Codex home')
  await fs.promises.mkdir(source)
  const system = path.join(source, 'auth.json')
  await fs.promises.writeFile(system, JSON.stringify(fixtureLogin(1)))
  // Discovery may get CODEX_HOME from a login shell rather than process.env.
  t.mock.method(require('../src/codex-discovery.ts'), 'resolveCodexLaunch', async executable => ({ executable, env: { ...process.env, CODEX_HOME: source } }))
  const executable = await launcher(root, 'fixture-codex', `
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline')
const home = process.env.CODEX_HOME
const file = path.join(home, 'fixture-sessions.json')
readline.createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line)
  if (!msg.method || msg.id === undefined) return
  let result = {}
  if (msg.method === 'thread/start') {
    const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : []
    saved.push(msg.params.id); fs.writeFileSync(file, JSON.stringify(saved))
    result = { thread: { id: msg.params.id }, home, sqlite: process.env.CODEX_SQLITE_HOME, args: process.argv.slice(2) }
  }
  if (msg.method === 'thread/list') result = { data: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : [] }
  const auth = path.join(home, 'auth.json')
  if (msg.method === 'account/read') result = { account: fs.existsSync(auth) ? { type: 'chatgpt' } : null }
  if (msg.method === 'account/rateLimits/read' && fs.existsSync(path.join(home, 'reject-login'))) {
    return process.stdout.write(JSON.stringify({ id: msg.id, error: { code: 401, message: 'Unauthorized' } }) + '\\n')
  }
  if (msg.method === 'account/login/start') {
    result = { loginId: 'fixture-login', authUrl: 'https://auth.openai.com/authorize' }
    setTimeout(() => {
      fs.writeFileSync(auth, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'private-login' } }))
      process.stdout.write(JSON.stringify({ method: 'account/login/completed', params: { loginId: 'fixture-login', success: true } }) + '\\n')
    }, 30)
  }
  process.stdout.write(JSON.stringify({ id: msg.id, result }) + '\\n')
})`)
  const a = resolveSessionSpace(root, 'codex', privateSpaceConfig('codex'))
  const b = resolveSessionSpace(root, 'codex', { mode: 'tabby', spaceId: 'b'.repeat(32) })
  const client = new CodexClient()
  t.after(() => client.close())
  await client.connect(executable, a)
  assert.equal((await client.request('account/read')).account.type, 'chatgpt')
  const started = await client.request('thread/start', { id: 'A', cwd: root })
  assert.equal(started.home, a.native); assert.equal(started.sqlite, a.native)
  assert.ok(started.args.some(arg => arg.startsWith('sqlite_home=')))
  const pid = client.process.pid
  await client.connect(executable, a); assert.equal(client.process.pid, pid)
  await client.connect(executable, b); assert.notEqual(client.process.pid, pid)
  assert.equal((await client.request('account/read')).account.type, 'chatgpt')
  assert.deepEqual((await client.request('thread/list')).data, [])
  await client.request('thread/start', { id: 'B', cwd: root })
  await client.close(); await client.connect(executable, a)
  assert.deepEqual((await client.request('thread/list')).data, ['A'])
  assert.deepEqual(JSON.parse(await fs.promises.readFile(path.join(b.native, 'fixture-sessions.json'))), ['B'])
  await fs.promises.writeFile(system, JSON.stringify(fixtureLogin(2)))
  await client.refreshAuthentication(executable, a, true)
  assert.equal((await client.request('account/read')).account.type, 'chatgpt')
  assert.deepEqual((await client.request('thread/list')).data, ['A'])
  await fs.promises.writeFile(system, JSON.stringify(fixtureLogin(3)))
  const denied = path.join(a.native, 'reject-login')
  await fs.promises.writeFile(denied, '')
  await assert.rejects(client.refreshAuthentication(executable, a, true), /Unauthorized/)
  await fs.promises.unlink(denied)
  await client.signOut(a)
  await client.connect(executable, a)
  assert.equal((await client.request('account/read')).account, null, 'sign-out persists without importing the system login')
  await assert.rejects(client.request('turn/start', { threadId: 'A' }), /not logged in/)
  let authUrl
  await client.signIn(executable, a, url => { authUrl = url }, new AbortController().signal)
  assert.equal(authUrl, 'https://auth.openai.com/authorize')
  assert.deepEqual((await client.request('thread/list')).data, ['A'])
  assert.deepEqual(JSON.parse(await fs.promises.readFile(system, 'utf8')), fixtureLogin(3))
  await assert.rejects(client.refreshAuthentication(executable, a), /没有可用的更新凭据/)
  assert.equal(JSON.parse(await fs.promises.readFile(path.join(a.native, 'auth.json'))).tokens.access_token, 'private-login')
})

test('Claude auth and inference use the same private space; restart resumes there and foreign IDs are rejected', async t => {
  const root = await temporary(t)
  await fs.promises.copyFile(path.join(__dirname, 'fixtures/claude-cli.cjs'), path.join(root, 'fixture.cjs'))
  await fs.promises.writeFile(path.join(root, 'scenario.json'), JSON.stringify({ captureEnvironment: true, requireLoginCache: true }))
  const sourceDirectory = path.join(root, 'original Claude directory')
  await fs.promises.mkdir(sourceDirectory)
  await fs.promises.writeFile(path.join(sourceDirectory, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-claude-login' } }))
  const inherited = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = sourceDirectory
  t.after(() => { if (inherited === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = inherited })
  const executable = await launcher(root, 'fixture-claude', `require('./fixture.cjs')`)
  const settings = { ...config(), cwd: root, claudeExecutable: executable, claudeModel: 'sonnet', defaultInstructions: { mode: 'inline', text: 'private-rule' } }
  const space = resolveSessionSpace(root, 'claude-code', privateSpaceConfig('claude-code'))
  const store = new AgentStore(path.join(space.root, 'index'))
  const agent = new ClaudeCodeAgent(claudeCodeProfile(settings), store, executable, space)
  t.after(() => agent.close())
  await agent.connect(settings)
  assert.equal(JSON.parse(await fs.promises.readFile(path.join(space.native, '.credentials.json'))).claudeAiOauth.accessToken, 'fixture-claude-login')
  const id = await agent.openThread(root, settings)
  const source = { sourceThreadId: 'source', sourceSpace: 'system:claude-code', sourceFingerprint: 'old', cwd: root, messages: [{ role: 'user', content: 'handoff only' }], turns: [], totalTokens: 0 }
  const transferred = await agent.importContext(source, root, settings)
  assert.equal(await agent.importContext(source, root, settings), transferred)
  const done = new Promise(resolve => {
    const observe = event => { if (event.method === 'turn/completed') { agent.off('event', observe); resolve(event.params.turn) } }
    agent.on('event', observe)
  })
  await agent.startTurn(id, 'respond', root, settings)
  assert.equal((await done).status, 'completed')
  const capture = JSON.parse(await fs.promises.readFile(path.join(root, 'capture.json')))
  assert.equal(capture.configDir, space.native)
  assert.equal(JSON.parse(await fs.promises.readFile(path.join(root, 'auth-environment.json'))).configDir, space.native)
  assert.match(capture.system, /private-rule/)
  const restarted = new ClaudeCodeAgent(claudeCodeProfile(settings), store, executable, space)
  t.after(() => restarted.close())
  assert.equal(await restarted.resumeThread(id, root, settings), id)
  const foreign = new ClaudeCodeAgent(claudeCodeProfile(settings), store, executable, { ...space, key: 'foreign' })
  await assert.rejects(foreign.resumeThread(id, root, settings), /空间/)
  assert.equal((await foreign.listSessions(root)).data.length, 0)
  await fs.promises.writeFile(path.join(space.native, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'expired-fixture' } }))
  await assert.rejects(agent.connect(settings), /Claude Code.*登录|Claude Code.*logged in/)
  await agent.refreshAuthentication(settings)
  assert.equal(JSON.parse(await fs.promises.readFile(path.join(space.native, '.credentials.json'))).claudeAiOauth.accessToken, 'fixture-claude-login')
  assert.equal(await agent.resumeThread(id, root, settings), id)
})

test('session space settings retain drafts and roll back a failed save without moving legacy history', async t => {
  const root = await temporary(t), settings = { ...config(), threads: { [root]: 'system-session' } }
  const configService = { store: { codexAgent: settings }, save: async () => { throw new Error('disk full') } }
  const component = new CodexSettingsComponent(configService, {}, { run: fn => fn() }, undefined, undefined, undefined, { getConfigPath: () => path.join(root, 'config.yaml') })
  assert.equal(component.nativeSpaceDraft.mode, 'system')
  component.changeNativeSpace('tabby'); await component.saveNativeSpace()
  assert.equal(settings.cliSessionSpaces, undefined); assert.match(component.nativeNotice, /disk full/)
  assert.equal(component.nativeSpaceDraft.mode, 'tabby')
  configService.save = async () => {}; await component.saveNativeSpace()
  assert.equal(settings.cliSessionSpaces.codex.mode, 'tabby')
  assert.match(component.nativeNotice, /reuses the local login cache/)
  assert.equal(settings.threads[root], 'system-session')
  component.ngOnDestroy()
})

test('native session locks reject a second writer and release after the owner finishes', async t => {
  const store = new AgentStore(await temporary(t))
  const unlock = await store.lockNativeSession('same-native-id')
  await assert.rejects(store.lockNativeSession('same-native-id'), /another window/)
  await unlock()
  const second = await store.lockNativeSession('same-native-id'); await second()
})
