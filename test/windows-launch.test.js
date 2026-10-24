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
const { CodexClient } = require('../src/codex-client.ts')
const { resolveCodexExecutable } = require('../src/codex-executable.ts')

// Real Windows executions, never reported as passing on a Linux host.
for (const extension of ['exe', 'cmd', 'bat']) {
  test(`Windows actual ${extension} path with spaces: initialization, JSONL streaming, stderr and clean environment`, { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby Windows 中文 & space-'))
    const client = new CodexClient()
    const env = { ...process.env }
    t.after(() => {
      for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]
      Object.assign(process.env, env)
    })
    t.after(async () => {
      const child = client.process
      const closed = child ? once(child, 'close') : Promise.resolve()
      client.close()
      await closed
      fs.rmSync(dir, { recursive: true, force: true })
    })
    const script = path.join(dir, 'server.js')
    fs.writeFileSync(script, `
const assert = require('assert/strict')
const rl = require('readline').createInterface({ input: process.stdin })
let initialized = false
rl.on('line', line => {
  const m = JSON.parse(line)
  if (m.method === 'initialize') {
    assert.equal(m.params.clientInfo.name, 'tabby_codex_agent')
    assert.ok(!Object.keys(process.env).some(k => k.toUpperCase() === 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE'))
    process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n')
  } else if (m.method === 'initialized') initialized = true
  else if (m.id) {
    assert.ok(initialized)
    process.stderr.write('stderr remains piped\\n')
    process.stdout.write(JSON.stringify({id:m.id,result:{ok:true}})+'\\n')
    process.stdout.write(JSON.stringify({method:'item/agentMessage/delta',params:{delta:'streamed'}})+'\\n')
  }
})
`)
    const executable = path.join(dir, `mock codex.${extension}`)
    if (extension === 'exe') {
      // Use a genuine PE executable. NODE_OPTIONS preloads the mock before Node
      // parses app-server arguments; this also proves the args arrive literally.
      fs.copyFileSync(process.execPath, executable)
      fs.writeFileSync(script, `require('assert/strict').deepEqual(process.argv.slice(2), ['--listen', 'stdio://'])\n` + fs.readFileSync(script, 'utf8') + `\nconst Module = require('module')
const load = Module._load
Module._load = function (request, parent, isMain) {
  if (isMain) return
  return load.call(this, request, parent, isMain)
}
`)
      process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} --require="${script.split(path.sep).join('/')}"`
    } else {
      fs.writeFileSync(executable, `@echo off\r\n"${process.execPath}" "%~dp0server.js" %*\r\n`)
    }
    const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH'
    process.env[pathKey] = ''
    process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = 'must-not-inherit'
    process.env.codex_internal_originator_override = 'must-not-inherit'
    await client.connect(executable)
    if (extension === 'exe') {
      assert.equal(client.process.spawnfile, executable)
      assert.deepEqual(client.process.spawnargs.slice(1), ['app-server', '--listen', 'stdio://'])
    }
    const delta = new Promise(resolve => client.once('event', resolve))
    const diagnostic = once(client, 'diagnostic')
    assert.deepEqual(await client.request('ping'), { ok: true })
    assert.equal((await delta).params.delta, 'streamed')
    assert.match((await diagnostic)[0], /stderr remains piped/)
  })
}

test('Windows actual npm.cmd prefix query discovers and starts a global codex.cmd', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby npm 中文 & space-'))
  const env = { ...process.env }
  const client = new CodexClient()
  t.after(async () => {
    const child = client.process
    const closed = child ? once(child, 'close') : Promise.resolve()
    client.close()
    await closed
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, env)
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const managers = path.join(dir, 'manager')
  const prefix = path.join(dir, 'global prefix')
  fs.mkdirSync(managers)
  fs.mkdirSync(prefix)
  fs.writeFileSync(path.join(managers, 'prefix.js'), `require('assert/strict').deepEqual(process.argv.slice(2), ['prefix', '-g']); process.stdout.write(${JSON.stringify(prefix)}+'\\n')`)
  fs.writeFileSync(path.join(managers, 'npm.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0prefix.js" %*\r\n`)
  const executable = path.join(prefix, 'codex.cmd')
  fs.writeFileSync(executable, `@echo off\r\n"${process.execPath}" "%~dp0server.js" %*\r\n`)
  fs.writeFileSync(path.join(prefix, 'server.js'), `require('readline').createInterface({input:process.stdin}).on('line', line => { const m=JSON.parse(line); if(m.id) process.stdout.write(JSON.stringify({id:m.id,result:{ok:true}})+'\\n') })`)
  for (const key of Object.keys(process.env)) if (['PATH', 'CODEX_HOME', 'CODEX_INSTALL_DIR', 'NPM_CONFIG_PREFIX', 'NODE_OPTIONS'].includes(key.toUpperCase())) delete process.env[key]
  Object.assign(process.env, { PATH: managers, CODEX_HOME: path.join(dir, 'codex home'), USERPROFILE: dir, LOCALAPPDATA: dir, APPDATA: path.join(dir, 'appdata') })
  await client.connect('codex')
  assert.deepEqual(await client.request('ping'), { ok: true })
  assert.ok(client.process.spawnargs.some(arg => arg.includes('codex.cmd')))
})

test('Windows actual no-PATH auto discovery selects real native executable and rescans upgrade hashes', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby auto space-'))
  const env = { ...process.env }
  const client = new CodexClient()
  t.after(async () => {
    const child = client.process
    const closed = child ? once(child, 'close') : Promise.resolve()
    client.close()
    await closed
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]
    Object.assign(process.env, env)
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH'
  process.env[pathKey] = ''
  process.env.LOCALAPPDATA = dir
  const bin = path.join(dir, 'OpenAI', 'Codex', 'bin')
  const install = hash => {
    const target = path.join(bin, hash, 'codex.exe')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(process.execPath, target)
    return target
  }
  const old = install('ffffffff')
  fs.utimesSync(old, 1000, 1000)
  fs.mkdirSync(path.join(bin, 'empty-hash'))
  const next = install('00000000')
  fs.utimesSync(next, 2000, 2000)
  assert.equal(resolveCodexExecutable(''), next)
  const preload = path.join(dir, 'preload.js')
  fs.writeFileSync(preload, `
require('readline').createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); if(m.id) process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n')
});
const Module = require('module'), load = Module._load
Module._load = function (request, parent, isMain) { if (!isMain) return load.call(this, request, parent, isMain) }
`)
  process.env.NODE_OPTIONS = `--require="${preload.split(path.sep).join('/')}"`
  await client.connect('')
  const child = client.process
  const closed = once(child, 'close')
  client.close()
  await closed
  const upgraded = install('9614f1d9b40d9c4f')
  fs.utimesSync(upgraded, 3000, 3000)
  assert.equal(resolveCodexExecutable('codex'), upgraded)
  await client.connect('codex')
  assert.equal(client.process.spawnfile, upgraded)
})
