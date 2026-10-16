const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { once } = require('node:events')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  }).outputText, filename)
}
const { resolveCodexLaunch } = require('../src/codex-discovery.ts')
const { CodexClient } = require('../src/codex-client.ts')
const posix = { skip: process.platform === 'win32', timeout: 10000 }
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'"

function fixture (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tabby NVM 中文 ' & space-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const context = {
    platform: 'linux', home: root, cwd: root, systemDirectories: [], shellTimeoutMs: 500,
    env: { HOME: root, PATH: path.join(root, 'desktop-bin'), SHELL: path.join(root, 'missing', 'bash') },
  }
  function file (relative, body) {
    const target = path.join(root, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, body, { mode: 0o755 })
    return target
  }
  function shell (body) {
    context.env.SHELL = file('user shell/bash', '#!/bin/sh\n' + body)
    return context.env.SHELL
  }
  return { root, context, file, shell }
}

const server = `#!/usr/bin/env node
const rl = require('readline').createInterface({ input: process.stdin })
rl.on('line', line => {
  const m = JSON.parse(line)
  if (m.id) process.stdout.write(JSON.stringify({ id: m.id, result: {
    args: process.argv.slice(2), path: process.env.PATH,
    overrides: Object.keys(process.env).filter(key => key.toUpperCase() === 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE'),
  } }) + '\\n')
})
`

for (const platform of ['linux', 'darwin']) {
  test(`${platform}: missing desktop PATH and failed Shell still discover NVM versions numerically`, posix, async t => {
    const f = fixture(t)
    f.context.platform = platform
    f.file('.nvm/versions/node/v9.99.0/bin/codex', server)
    f.file('.nvm/versions/node/v20.99.0/bin/codex', server)
    const target = f.file('.nvm/versions/node/v22.1.0/bin/codex', server)
    fs.mkdirSync(path.join(f.root, '.nvm/versions/node/v30.0.0/bin'), { recursive: true })
    fs.mkdirSync(path.join(f.root, '.nvm/versions/node/v99.0.0/bin/codex'), { recursive: true })
    const parent = { ...f.context.env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'parent' }
    const launch = await resolveCodexLaunch('', { ...f.context, env: parent })
    assert.equal(launch.executable, target)
    assert.equal(launch.env.PATH, path.dirname(target) + ':' + parent.PATH)
    assert.equal(launch.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, undefined)
    assert.equal(parent.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, 'parent')
    fs.unlinkSync(target)
    assert.match((await resolveCodexLaunch('codex', f.context)).executable, /v20\.99\.0/)
  })
}

test('custom NVM_DIR is supported and current symlink precedes version scanning', posix, async t => {
  const f = fixture(t)
  f.context.env.NVM_DIR = path.join(f.root, 'custom nvm')
  const target = f.file('custom nvm/versions/node/v18.1.0/bin/codex', server)
  f.file('custom nvm/versions/node/v22.1.0/bin/codex', server)
  fs.symlinkSync('versions/node/v18.1.0', path.join(f.context.env.NVM_DIR, 'current'))
  assert.equal((await resolveCodexLaunch('codex', f.context)).executable, path.join(f.context.env.NVM_DIR, 'current/bin/codex'))
  fs.unlinkSync(path.join(f.context.env.NVM_DIR, 'current'))
  fs.unlinkSync(path.join(f.context.env.NVM_DIR, 'versions/node/v22.1.0/bin/codex'))
  assert.equal((await resolveCodexLaunch('codex', f.context)).executable, target)
})

test('Shell PATH uses its own pipe, handles banners and preserves PATH for Node and tools', posix, async t => {
  const f = fixture(t)
  const target = f.file('shell tools/codex', server)
  f.file('.nvm/versions/node/v99.0.0/bin/codex', server)
  const shellPath = path.dirname(target) + ':' + path.join(f.root, 'node and tools')
  f.shell(`test "$1" = -ilc || exit 9\nprintf 'startup banner\\n'\nprintf 'startup warning\\n' >&2\nPATH=${quote(shellPath)}\nexport PATH\neval "$2"\n`)
  const launch = await resolveCodexLaunch('codex', f.context)
  assert.equal(launch.executable, target)
  assert.ok(launch.env.PATH.includes(shellPath))
  assert.ok(launch.env.PATH.endsWith(f.context.env.PATH))
  assert.equal(f.context.env.PATH, path.join(f.root, 'desktop-bin'))
})

test('a valid Shell PATH is retained when Codex is found in an installation directory', posix, async t => {
  const f = fixture(t)
  const target = f.file('.local/bin/codex', server)
  const tools = path.join(f.root, 'shell node')
  f.shell(`PATH=${quote(tools)}\nexport PATH\neval "$2"\n`)
  const launch = await resolveCodexLaunch('', f.context)
  assert.equal(launch.executable, target)
  assert.ok(launch.env.PATH.includes(tools))
})

test('PATH and explicit files win; custom names and invalid explicit paths never probe Shell or NVM', posix, async t => {
  const f = fixture(t)
  const target = f.file('desktop-bin/codex', server)
  const marker = path.join(f.root, 'probe-ran')
  f.shell(`printf ran > ${quote(marker)}\nexit 17\n`)
  f.file('.nvm/versions/node/v22.1.0/bin/codex', server)
  f.file('.nvm/versions/node/v22.1.0/bin/custom-agent', server)
  assert.equal((await resolveCodexLaunch('', f.context)).executable, target)
  assert.equal((await resolveCodexLaunch(`"${target}"`, f.context)).executable, target)
  await assert.rejects(resolveCodexLaunch('~/missing/codex', f.context), /显式.*无效.*未尝试自动查找/s)
  await assert.rejects(resolveCodexLaunch('custom-agent', f.context), /PATH.*未尝试其他安装/s)
  assert.equal(fs.existsSync(marker), false)
})

for (const [name, body, pattern] of [
  ['exit', 'exit 17\n', /探测退出（17）/],
  ['missing data', 'printf banner\n', /未返回有效 PATH/],
  ['oversized data', `printf '%s' ${quote('x'.repeat(66000))} >&3\n`, /超过 64 KiB/],
  ['timeout', 'exec /bin/sleep 30\n', /探测超时/],
]) {
  test(`no Codex and Shell ${name} produce bounded, actionable errors`, posix, async t => {
    const f = fixture(t)
    f.shell(body)
    let responsive = false
    const tick = setTimeout(() => { responsive = true }, 10)
    t.after(() => clearTimeout(tick))
    await assert.rejects(resolveCodexLaunch('', f.context), error => {
      assert.match(error.message, /找不到 Codex CLI/)
      assert.match(error.message, /PATH:/)
      assert.match(error.message, pattern)
      assert.match(error.message, /补充安装目录/)
      assert.match(error.message, /codexAgent.executable/)
      return true
    })
    if (name === 'timeout') assert.equal(responsive, true, 'discovery must not block the event loop')
  })
}

test('Shell timeout and unsupported Shell still permit NVM fallback', posix, async t => {
  const f = fixture(t)
  const target = f.file('.nvm/versions/node/v22.1.0/bin/codex', server)
  f.shell('exec /bin/sleep 30\n')
  assert.equal((await resolveCodexLaunch('', f.context)).executable, target)
  f.context.env.SHELL = '/bin/unsupported-shell'
  assert.equal((await resolveCodexLaunch('', f.context)).executable, target)
})

function inheritFixture (t, env) {
  const parent = { ...process.env }
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
  t.after(() => {
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, parent)
  })
}

test('actual client starts NVM #!/usr/bin/env node launcher with desktop PATH missing Node', posix, async t => {
  const f = fixture(t)
  const executable = f.file('.nvm/versions/node/v22.1.0/bin/codex', server)
  fs.symlinkSync(process.execPath, path.join(path.dirname(executable), 'node'))
  inheritFixture(t, { ...f.context.env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'parent' })
  const client = new CodexClient()
  t.after(async () => {
    const child = client.process
    const closed = child ? once(child, 'close') : Promise.resolve()
    client.close()
    await closed
  })
  await client.connect('codex')
  assert.equal(client.process.spawnfile, executable)
  const result = await client.request('ping')
  assert.deepEqual(result.args, ['app-server', '--listen', 'stdio://'])
  assert.equal(result.path.split(':')[0], path.dirname(executable))
  assert.deepEqual(result.overrides, [])
  assert.equal(process.env.PATH, f.context.env.PATH)
  assert.equal(process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, 'parent')
  client.close()
  await client.connect(executable)
  assert.equal(client.isConnected, true, 'explicit launcher also finds its adjacent Node')
})

test('actual client forwards the Shell PATH through the JSONL handshake', posix, async t => {
  const f = fixture(t)
  const executable = f.file('shell codex/codex', server)
  const node = f.file('separate node/placeholder', '')
  fs.symlinkSync(process.execPath, path.join(path.dirname(node), 'node'))
  f.shell(`PATH=${quote(path.dirname(executable) + ':' + path.dirname(node))}\nexport PATH\neval "$2"\n`)
  inheritFixture(t, f.context.env)
  const client = new CodexClient()
  t.after(async () => {
    const child = client.process
    const closed = child ? once(child, 'close') : Promise.resolve()
    client.close()
    await closed
  })
  await client.connect('')
  assert.equal(client.process.spawnfile, executable)
  assert.ok((await client.request('ping')).path.includes(path.dirname(node)))
})

test('close and changing settings cancel pending discovery without spawning a late server', posix, async t => {
  const f = fixture(t)
  f.shell('exec /bin/sleep 30\n')
  inheritFixture(t, f.context.env)
  const client = new CodexClient()
  t.after(() => client.close())
  const first = client.connect('codex')
  const rejected = assert.rejects(first, /closed during CLI discovery/)
  client.close()
  await rejected
  assert.equal(client.process, undefined)
  const second = client.connect('codex')
  const replaced = assert.rejects(second, /closed during CLI discovery/)
  const executable = f.file('explicit/codex', server.replace('#!/usr/bin/env node', '#!' + process.execPath))
  await client.connect(executable)
  await replaced
  assert.equal(client.process.spawnfile, executable)
  assert.equal(client.isConnected, true)
})
