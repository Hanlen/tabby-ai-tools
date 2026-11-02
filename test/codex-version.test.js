const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  }).outputText, filename)
}
const { newestCodexExecutable } = require('../src/codex-version.ts')
const { resolveCodexLaunch } = require('../src/codex-discovery.ts')

function fixture (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby CLI versions 中文 & space-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
  const context = { platform: 'win32', paths: path, home: root, cwd: root,
    systemDirectories: [], env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, ComSpec: process.env.ComSpec,
      PATHEXT: '.EXE;.CMD;.BAT', PATH: '', USERPROFILE: root, LOCALAPPDATA: root, CODEX_HOME: path.join(root, '.codex') } }
  const bin = path.join(root, 'OpenAI', 'Codex', 'bin')
  function cli (relative, output, options = {}) {
    const executable = path.join(root, relative + (process.platform === 'win32' ? '.cmd' : '.exe'))
    fs.mkdirSync(path.dirname(executable), { recursive: true })
    const script = executable + '.js'
    fs.writeFileSync(script, `require('node:assert/strict').deepEqual(process.argv.slice(2), ['--version']);\n` +
      (options.hang ? 'setInterval(() => {}, 1000)' : `process.stdout.write(${JSON.stringify(output)}); process.exitCode=${options.code || 0}`))
    fs.writeFileSync(executable, process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "%~dp0${path.basename(script)}" %*\r\n`
      : `#!${process.execPath}\n${fs.readFileSync(script, 'utf8')}`, { mode: 0o755 })
    return executable
  }
  function desktop (hash, output) {
    const filename = cli(`OpenAI/Codex/bin/${hash}/codex`, output)
    // Desktop discovery requires codex.exe; these fixtures execute on POSIX.
    return filename
  }
  return { root, context, bin, cli, desktop }
}

test('Windows default launch compares all PATH and desktop versions, ignoring newer file dates', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t)
  const old = f.cli('.local/bin/codex', 'codex-cli 0.99.0\n')
  const intermediate = f.desktop('ffffffff', 'codex-cli 0.105.0\n')
  const latest = f.desktop('00000000', 'codex-cli 0.110.0\n')
  fs.utimesSync(old, 5000, 5000)
  fs.utimesSync(intermediate, 4000, 4000)
  fs.utimesSync(latest, 1000, 1000)
  f.context.env.PATH = path.dirname(old)
  assert.equal((await resolveCodexLaunch('', f.context)).executable, latest)
  assert.equal((await resolveCodexLaunch('codex', f.context)).executable, latest)
  assert.equal((await resolveCodexLaunch(f.bin, f.context)).executable, latest)
  assert.equal((await resolveCodexLaunch(old, f.context)).executable, old)
  const newerPath = f.cli('another PATH/codex', 'codex-cli 0.111.0\n')
  f.context.env.PATH += ';' + path.dirname(newerPath)
  assert.equal((await resolveCodexLaunch('codex', f.context)).executable, newerPath)
  fs.unlinkSync(newerPath)
  fs.unlinkSync(latest)
  assert.equal((await resolveCodexLaunch(latest, f.context)).executable, intermediate)
})

test('default launch picks the newest of multiple PATH launchers on the actual host', async t => {
  const f = fixture(t)
  const old = f.cli('old PATH/codex', 'codex-cli 0.99.0')
  const latest = f.cli('new PATH/codex', 'codex-cli 0.110.0')
  f.context.env.PATH = path.dirname(old) + ';' + path.dirname(latest)
  assert.equal((await resolveCodexLaunch('codex', f.context)).executable, latest)
  assert.equal((await resolveCodexLaunch(old, f.context)).executable, old)
})

test('version probes compare numeric semver and stable/prerelease precedence with deterministic ties', async t => {
  const f = fixture(t)
  const outputs = ['codex-cli 0.9.0', 'codex-cli 0.100.0-alpha.2', 'codex-cli 0.100.0-alpha.10', 'codex-cli 0.100.0', 'codex-cli 0.100.0+build']
  const files = outputs.map((output, i) => f.cli(`cli-${i}`, output))
  assert.equal(await newestCodexExecutable(files.slice(0, 3), process.env), files[2])
  assert.equal(await newestCodexExecutable(files, process.env), files[3])
})

test('failed, malformed, excessive and timed-out version probes cannot outrank a valid version', async t => {
  const f = fixture(t)
  const files = [f.cli('failed', 'codex-cli 99.0.0', { code: 1 }),
    f.cli('malformed', 'node v99.0.0'), f.cli('huge', 'x'.repeat(20000)),
    f.cli('timeout', '', { hang: true }), f.cli('valid', 'codex-cli 0.110.0')]
  assert.equal(await newestCodexExecutable(files, process.env, { versionTimeoutMs: 4000 }), files[4])
  assert.equal(await newestCodexExecutable(files.slice(0, 2), process.env), files[0], 'all unknown keeps discovery order')
})

test('cancellation stops version discovery and does not select an old CLI', async t => {
  const f = fixture(t)
  const controller = new AbortController()
  const pending = newestCodexExecutable([f.cli('hang', '', { hang: true })], process.env, { signal: controller.signal })
  setTimeout(() => controller.abort(), 50)
  await assert.rejects(pending, /closed during CLI discovery/)
})

// Verify cancellation through the real discovery boundary, not just the probe.
test('cancelling default Windows discovery cannot return a selected PATH fallback', async t => {
  const f = fixture(t)
  const old = f.cli('first/codex', '', { hang: true })
  const next = f.cli('second/codex', '', { hang: true })
  f.context.env.PATH = path.dirname(old) + ';' + path.dirname(next)
  const controller = new AbortController()
  const pending = resolveCodexLaunch('codex', { ...f.context, signal: controller.signal })
  setTimeout(() => controller.abort(), 50)
  await assert.rejects(pending, /closed during CLI discovery/)
})
