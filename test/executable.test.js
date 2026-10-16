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
const { resolveCodexExecutable, codexEnvironment } = require('../src/codex-executable.ts')

function fixture (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby discovery 中文 space-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const local = path.join(root, 'Local AppData')
  const bin = path.join(local, 'OpenAI', 'Codex', 'bin')
  const context = { platform: 'win32', paths: path, env: { Path: '', LocalAppData: local }, cwd: root }
  function file (relative, mtime = 1000) {
    const filename = path.join(root, relative)
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    fs.writeFileSync(filename, 'fixture (discovery only)')
    fs.utimesSync(filename, mtime, mtime)
    return filename
  }
  function install (hash, mtime) { return file(path.relative(root, path.join(bin, hash, 'codex.exe')), mtime) }
  return { root, local, bin, context, file, install }
}

test('Windows discovery simulation: empty PATH scans hashes, skips old empty directories and picks executable mtime', t => {
  const f = fixture(t)
  const old = f.install('ffffffffffffffff', 2000)
  const newest = f.install('0000000000000000', 3000)
  fs.mkdirSync(path.join(f.bin, '9614f1d9b40d9c4f'), { recursive: true })
  fs.mkdirSync(path.join(f.bin, 'directory-instead-of-file', 'codex.exe'), { recursive: true })
  fs.utimesSync(path.dirname(old), 9000, 9000)
  assert.equal(resolveCodexExecutable('', f.context), newest)
  assert.equal(resolveCodexExecutable('codex', f.context), newest)
  const upgrade = f.install('1234abcdef567890', 4000)
  assert.equal(resolveCodexExecutable('codex', f.context), upgrade, 'new connection rescans after upgrade')
  fs.unlinkSync(upgrade)
  assert.equal(resolveCodexExecutable('codex', f.context), newest, 'removed install is not cached')
  fs.utimesSync(old, 3000, 3000)
  assert.equal(resolveCodexExecutable('codex', f.context), [old, newest].sort()[0], 'mtime tie has stable path ordering')
})

test('Windows PATH precedes desktop install; custom names use case-insensitive PATH/PATHEXT without desktop fallback', t => {
  const f = fixture(t)
  f.install('hash', 5000)
  const cmd = f.file('Path With Spaces/codex.cmd')
  const exe = f.file('Other Path/codex.exe')
  f.context.env.pAtH = `"${path.dirname(cmd)}";${path.dirname(exe)}`
  delete f.context.env.Path
  f.context.env.pAtHeXt = '.EXE;.CMD;.BAT'
  assert.equal(resolveCodexExecutable('codex', f.context), cmd)
  const custom = f.file('Path With Spaces/my-agent.bat')
  assert.equal(resolveCodexExecutable('my-agent', f.context), custom)
  assert.equal(resolveCodexExecutable('my-agent.bat', f.context), custom)
  assert.throws(() => resolveCodexExecutable('missing-command', f.context), /missing-command.*PATH.*未尝试其他安装/s)
})

test('explicit paths have priority, strip outer quotes, expand home and never fall back', t => {
  const f = fixture(t)
  f.install('hash', 5000)
  for (const extension of ['exe', 'cmd', 'bat']) {
    const explicit = f.file(`Explicit Path/agent.${extension}`)
    assert.equal(resolveCodexExecutable(`"${explicit}"`, f.context), explicit)
    assert.equal(resolveCodexExecutable(`~/Explicit Path/agent.${extension}`, { ...f.context, home: f.root }), explicit)
  }
  assert.throws(() => resolveCodexExecutable(path.join(f.root, 'missing.exe'), f.context), /显式.*无效.*未尝试自动查找.*ENOENT.*codexAgent.executable/s)
  assert.throws(() => resolveCodexExecutable(f.bin, f.context), /不是普通文件/)
  assert.throws(() => resolveCodexExecutable(f.file('bad.txt'), f.context), /仅支持/)
})

test('not-found errors explain PATH, LOCALAPPDATA, rejected candidates and setting entry', t => {
  const f = fixture(t)
  assert.throws(() => resolveCodexExecutable('', f.context), error => {
    assert.match(error.message, /PATH: 未设置或为空/)
    assert.ok(error.message.includes(f.bin))
    assert.match(error.message, /ENOENT/)
    assert.match(error.message, /codexAgent.executable/)
    return true
  })
  assert.throws(() => resolveCodexExecutable('codex', { ...f.context, env: {} }), /LOCALAPPDATA: 未设置/)
  fs.mkdirSync(path.join(f.bin, 'old-hash'), { recursive: true })
  assert.throws(() => resolveCodexExecutable('', f.context), /old-hash.*codex.exe: ENOENT.*没有可用/s)
})

test('POSIX PATH discovery verifies execution permission and returns an absolute file', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t)
  const bad = f.file('not-executable/codex')
  const good = f.file('executable/codex')
  fs.chmodSync(bad, 0o644)
  fs.chmodSync(good, 0o755)
  const context = { platform: 'linux', env: { PATH: [path.dirname(bad), path.dirname(good)].join(':') } }
  assert.equal(resolveCodexExecutable('', context), good)
  assert.throws(() => resolveCodexExecutable(bad, context), /EACCES/)
  assert.throws(() => resolveCodexExecutable('', { ...context, env: {} }), /PATH: 未设置或为空/)
})

test('originator override is removed in all casings without mutating parent environment', () => {
  const parent = { PATH: 'keep', CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'one', codex_internal_originator_override: 'two', Codex_Internal_Originator_Override: 'three', OTHER: 'keep' }
  assert.deepEqual(codexEnvironment(parent), { PATH: 'keep', OTHER: 'keep' })
  assert.equal(Object.keys(parent).length, 5)
})
