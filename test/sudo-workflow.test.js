const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const ts = require('typescript')
const original = require.extensions['.ts']
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
}).outputText, filename)
const { SudoWorkflowLease } = require('../src/sudo-workflow.ts')
require.extensions['.ts'] = original

test('failed noninteractive sudo preflight blocks the whole command without a password prompt', { skip: process.platform === 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-sudo-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'sudo'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
  const lease = new SudoWorkflowLease()
  const result = spawnSync('sh', ['-c', lease.wrap('echo SHOULD_NOT_RUN')], { env: { ...process.env, PATH: root + path.delimiter + process.env.PATH }, encoding: 'utf8' })
  assert.doesNotMatch(result.stdout, /SHOULD_NOT_RUN/)
  assert.match(result.stderr, /THIS terminal/)
})

test('lease refreshes across commands and stops after task cleanup', { skip: process.platform === 'win32' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-sudo-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'sudo'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_SUDO_LOG"\n', { mode: 0o700 })
  fs.writeFileSync(path.join(root, 'sleep'), '#!/bin/sh\n/bin/sleep 0.02\n', { mode: 0o700 })
  const lease = new SudoWorkflowLease()
  const result = spawnSync('sh', ['-c', lease.wrap('echo FIRST') + '\n/bin/sleep .12\n' + lease.wrap('echo SECOND') + '\n' + lease.cleanup() + '\n/bin/sleep .08'], {
    env: { ...process.env, PATH: root + path.delimiter + process.env.PATH, TMPDIR: root, TEST_SUDO_LOG: path.join(root, 'log') }, encoding: 'utf8', timeout: 5000,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /FIRST\nSECOND/)
  const before = fs.readFileSync(path.join(root, 'log'), 'utf8')
  assert.ok(before.trim().split('\n').length > 3, 'refreshes while waiting between commands')
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(fs.readFileSync(path.join(root, 'log'), 'utf8'), before)
  assert.equal(fs.readdirSync(root).filter(file => file.startsWith('tabby-sudo.')).length, 0)
})
