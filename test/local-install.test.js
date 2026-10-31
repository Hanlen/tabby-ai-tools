const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

test('local install copies the built Pi bundle without npm or node on PATH', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-local-install-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const missingNode = path.join(root, 'empty-path')
  fs.mkdirSync(missingNode)
  // npm test builds Pi before webpack; isolate the file-copy installer from the
  // main bundle while keeping the actual built sidecar in the fixture.
  const source = path.join(root, 'source')
  for (const name of ['scripts', 'dist/pi', 'docs', 'skills']) fs.mkdirSync(path.join(source, name), { recursive: true })
  fs.copyFileSync(path.resolve(__dirname, '../scripts/install-local.mjs'), path.join(source, 'scripts/install-local.mjs'))
  fs.copyFileSync(path.resolve(__dirname, '../package.json'), path.join(source, 'package.json'))
  fs.writeFileSync(path.join(source, 'dist/index.js'), '// installer copy fixture')
  for (const name of ['sidecar.mjs', 'electron-host.cjs', 'THIRD_PARTY_NOTICES.txt']) fs.copyFileSync(path.resolve(__dirname, '../dist/pi', name), path.join(source, 'dist/pi', name))
  fs.writeFileSync(path.join(source, 'docs/provider-roadmap.md'), 'Local planning fixture; never install.')
  const env = { ...process.env, PATH: missingNode, npm_execpath: '', NODE_OPTIONS: '' }
  for (const name of Object.keys(env)) if (name !== 'PATH' && name.toUpperCase() === 'PATH') delete env[name]
  const result = spawnSync(process.execPath, [path.join(source, 'scripts/install-local.mjs'), path.join(root, 'plugins')], { env, encoding: 'utf8', timeout: 15000 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const destination = path.join(root, 'plugins', 'node_modules', 'tabby-ai-tools')
  assert.equal(fs.readFileSync(path.join(destination, 'dist/pi/sidecar.mjs'), 'utf8'), fs.readFileSync(path.resolve(__dirname, '../dist/pi/sidecar.mjs'), 'utf8'))
  assert.ok(fs.readFileSync(path.join(destination, 'dist/pi/THIRD_PARTY_NOTICES.txt')).length)
  assert.equal(fs.existsSync(path.join(destination, 'node_modules')), false)
  assert.equal(fs.existsSync(path.join(destination, 'docs/provider-roadmap.md')), false)
})
