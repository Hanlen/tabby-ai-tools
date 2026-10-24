const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  }).outputText, filename)
}
const { resolveCodexLaunch } = require('../src/codex-discovery.ts')
const { resolveCodexExecutable } = require('../src/codex-executable.ts')
const posix = { skip: process.platform === 'win32', timeout: 10000 }
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'"

function fixture (t, platform = 'linux', arch = 'x64') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tabby installs 中文 ' & space-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const context = {
    platform, arch, paths: path, home: root, cwd: root,
    systemDirectories: [], applicationDirectories: [path.join(root, 'Applications')],
    prefixTimeoutMs: 300, shellTimeoutMs: 100,
    env: { HOME: root, USERPROFILE: root, PATH: '', SHELL: path.join(root, 'missing', 'bash') },
  }
  function file (relative, body = '#!/bin/sh\nexit 0\n') {
    const target = path.join(root, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, body, { mode: 0o755 })
    return target
  }
  return { root, context, file }
}

for (const platform of ['linux', 'darwin', 'win32']) {
  test(`${platform}: standalone internal entry honors CODEX_HOME and current layout`, async t => {
    const f = fixture(t, platform)
    const filename = platform === 'win32' ? 'codex.exe' : 'codex'
    const fallback = f.file(`.codex/packages/standalone/current/bin/${filename}`)
    assert.equal((await resolveCodexLaunch('', f.context)).executable, fallback)
    const target = f.file(`custom home/packages/standalone/current/bin/${filename}`)
    f.context.env[platform === 'win32' ? 'codex_home' : 'CODEX_HOME'] = '"~/custom home"'
    assert.equal((await resolveCodexLaunch('', f.context)).executable, target)
    const legacy = f.file(`custom home/packages/standalone/current/${filename}`)
    fs.unlinkSync(target)
    assert.equal((await resolveCodexLaunch('', f.context)).executable, legacy)
    const configured = f.file(`custom install/${filename}`)
    f.context.env.CODEX_INSTALL_DIR = path.dirname(configured)
    assert.equal((await resolveCodexLaunch('', f.context)).executable, configured)
    const fromPath = f.file(`PATH/${filename}`)
    f.context.env.PATH = path.dirname(fromPath)
    assert.equal((await resolveCodexLaunch('', f.context)).executable, fromPath)
    await assert.rejects(resolveCodexLaunch('missing-agent', f.context), /未尝试其他安装/)
  })
}

for (const app of ['ChatGPT.app', 'Codex.app']) {
  for (const layout of ['codex-cli/bin/codex', 'codex']) {
    test(`macOS app bundle: ${app}/Contents/Resources/${layout}`, async t => {
      const f = fixture(t, 'darwin')
      const target = f.file(`Applications/${app}/Contents/Resources/${layout}`)
      assert.equal((await resolveCodexLaunch('', f.context)).executable, target)
      assert.equal((await resolveCodexLaunch(`"${target}"`, f.context)).executable, target)
      const standalone = f.file('.local/bin/codex')
      assert.equal((await resolveCodexLaunch('', f.context)).executable, standalone)
      fs.unlinkSync(standalone)
      const systemRoot = path.join(f.root, 'system Applications')
      fs.mkdirSync(systemRoot)
      fs.renameSync(path.join(f.root, 'Applications', app), path.join(systemRoot, app))
      f.context.applicationDirectories = [systemRoot]
      assert.equal((await resolveCodexLaunch('', f.context)).executable, path.join(systemRoot, app, 'Contents/Resources', layout))
    })
  }
}

test('macOS prefers the new desktop layout and tolerates a dangling old PATH symlink', posix, async t => {
  const f = fixture(t, 'darwin')
  f.file('Applications/ChatGPT.app/Contents/Resources/codex')
  const target = f.file('Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex')
  const old = path.join(f.root, 'old PATH')
  fs.mkdirSync(old)
  fs.symlinkSync(path.join(f.root, 'removed Codex'), path.join(old, 'codex'))
  f.context.env.PATH = old
  assert.equal((await resolveCodexLaunch('', f.context)).executable, target)
})

for (const [platform, key, relative] of [
  ['linux', 'NPM_CONFIG_PREFIX', 'custom npm/bin/codex'],
  ['darwin', 'HOMEBREW_PREFIX', 'custom brew/bin/codex'],
  ['win32', 'npm_config_prefix', 'custom npm/codex.cmd'],
  ['win32', 'aPpDaTa', 'custom appdata/npm/codex.cmd'],
]) {
  test(`${platform}: ${key} prefix supplies the correct binary location`, async t => {
    const f = fixture(t, platform)
    const target = f.file(relative)
    f.context.env[key] = path.join(f.root, relative.split('/')[0])
    assert.equal((await resolveCodexLaunch('', f.context)).executable, target)
  })
}

for (const [platform, manager, name, expectedArgs] of [
  ['darwin', 'brew', 'codex', ['--prefix']],
  ['linux', 'npm', 'codex', ['prefix', '-g']],
  ['win32', 'npm.exe', 'codex.cmd', ['prefix', '-g']],
]) {
  test(`${platform}: queries ${manager} for a custom global prefix`, posix, async t => {
    const f = fixture(t, platform)
    const prefix = path.join(f.root, 'nondefault prefix')
    const target = f.file(`nondefault prefix/${platform === 'win32' ? '' : 'bin/'}${name}`)
    const args = expectedArgs.map((arg, i) => `test "$${i + 1}" = ${quote(arg)} || exit 9`).join('\n')
    const query = f.file(`manager/${manager}`, `#!/bin/sh\n${args}\nprintf '%s\\n' ${quote(prefix)}\n`)
    f.context.env.PATH = path.dirname(query)
    assert.equal((await resolveCodexLaunch('', f.context)).executable, target)
    const cli = f.file(`manager/${platform === 'win32' ? 'codex.exe' : 'codex'}`)
    fs.writeFileSync(query, '#!/bin/sh\nexit 99\n')
    assert.equal((await resolveCodexLaunch('', f.context)).executable, cli, 'PATH selection is retained without running managers')
  })
}

test('npm prefix query recovers its Node runtime from NVM', posix, async t => {
  const f = fixture(t)
  const target = f.file('queried prefix/bin/codex')
  const query = f.file('manager/npm', '#!/usr/bin/env node\nprocess.stdout.write(' + JSON.stringify(path.dirname(path.dirname(target))) + '+"\\n")\n')
  const nodeDir = path.join(f.root, '.nvm/versions/node/v22.1.0/bin')
  fs.mkdirSync(nodeDir, { recursive: true })
  fs.symlinkSync(process.execPath, path.join(nodeDir, 'node'))
  f.context.env.PATH = path.dirname(query)
  assert.equal((await resolveCodexLaunch('', f.context)).executable, target)
})

for (const [name, body, pattern] of [
  ['failure', 'exit 17\n', /prefix 退出码 17/],
  ['relative', 'printf relative-secret-path\n', /单行绝对路径/],
  ['multiple lines', "printf '/secret-one\\n/secret-two\\n'\n", /单行绝对路径/],
  ['oversized', `printf '%s' ${quote('secret'.repeat(3000))}\n`, /16 KiB/],
  ['timeout', 'exec /bin/sleep 30\n', /prefix 探测超时/],
]) {
  test(`prefix ${name} is bounded, hides query output and permits desktop fallback`, posix, async t => {
    const f = fixture(t, 'darwin')
    const query = f.file('manager/npm', '#!/bin/sh\n' + body)
    f.context.env.PATH = path.dirname(query)
    await assert.rejects(resolveCodexLaunch('', f.context), error => {
      assert.match(error.message, pattern)
      assert.ok(!error.message.includes('secret'))
      return true
    })
    const app = f.file('Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex')
    assert.equal((await resolveCodexLaunch('', f.context)).executable, app)
  })
}

test('cancelling a prefix query kills its process tree and cancels later discovery', posix, async t => {
  const f = fixture(t, 'darwin')
  const pidFile = path.join(f.root, 'query.pid')
  const query = f.file('manager/npm', `#!/bin/sh\nprintf '%s' $$ > ${quote(pidFile)}\nexec /bin/sleep 30\n`)
  f.context.env.PATH = path.dirname(query)
  f.context.prefixTimeoutMs = 5000
  f.file('Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex')
  const controller = new AbortController()
  const pending = resolveCodexLaunch('', { ...f.context, signal: controller.signal })
  const rejected = assert.rejects(pending, /closed during CLI discovery/)
  for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await delay(10)
  assert.ok(fs.existsSync(pidFile))
  const pid = Number(fs.readFileSync(pidFile, 'utf8'))
  controller.abort()
  await rejected
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})

for (const [platform, arch, folder] of [
  ['linux', 'x64', 'linux-x86_64'], ['linux', 'arm64', 'linux-aarch64'],
  ['darwin', 'x64', 'darwin-x86_64'], ['darwin', 'arm64', 'darwin-aarch64'],
  ['win32', 'x64', 'windows-x86_64'], ['win32', 'arm64', 'windows-aarch64'],
  ['win32', 'x64', 'win32-x64'],
]) {
  test(`${platform}/${arch}: IDE fallback uses a compatible platform and newest valid extension`, async t => {
    const f = fixture(t, platform, arch)
    const name = platform === 'win32' ? 'codex.exe' : 'codex'
    const old = f.file(`.vscode/extensions/openai.chatgpt-26.9.1/bin/${folder}/${name}`)
    const current = f.file(`.vscode-server/extensions/openai.chatgpt-26.10.1/bin/${folder}/${name}`)
    f.file(`.vscode/extensions/openai.chatgpt-99.0.0/bin/wrong-architecture/${name}`)
    f.file(`.vscode/extensions/other.publisher-100.0.0/bin/${folder}/${name}`)
    assert.equal((await resolveCodexLaunch('', f.context)).executable, current)
    fs.unlinkSync(current)
    assert.equal((await resolveCodexLaunch('', f.context)).executable, old)
    await assert.rejects(resolveCodexLaunch('custom-agent', f.context), /未尝试其他安装/)
    const direct = f.file(`selected/${name}`)
    assert.equal((await resolveCodexLaunch(direct, f.context)).executable, direct)
  })
}

test('unsupported architecture never falls back to another IDE architecture', async t => {
  const f = fixture(t, 'linux', 'ia32')
  f.file('.vscode/extensions/openai.chatgpt-99.0.0/bin/linux-x86_64/codex')
  await assert.rejects(resolveCodexLaunch('', f.context), /IDE: 不支持的架构 ia32/)
})

test('Windows synchronous discovery finds internal standalone even without LOCALAPPDATA', t => {
  const f = fixture(t, 'win32')
  const target = f.file('.codex/packages/standalone/current/bin/codex.exe')
  assert.equal(resolveCodexExecutable('', f.context), target)
})
