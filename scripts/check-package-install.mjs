import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npmCli = process.env.npm_execpath
assert.ok(npmCli, 'Run this check with npm run test:package')
const root = mkdtempSync(join(tmpdir(), 'tabby-package-install-'))
const manifest = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'))
const runNpm = (args, cwd, env = process.env) => spawnSync(process.execPath, [npmCli, ...args], {
  cwd, env, encoding: 'utf8', timeout: 120000, shell: false,
})
const successful = result => {
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stdout + result.stderr)
}
try {
  let archive
  if (process.argv[2]) archive = resolve(process.argv[2])
  else {
    successful(runNpm(['pack', '--ignore-scripts', '--pack-destination', root], project))
    archive = join(root, `${manifest.name}-${manifest.version}.tgz`)
  }
  const missingNode = join(root, 'empty-path')
  mkdirSync(missingNode)
  const env = { ...process.env, PATH: missingNode, NODE_PATH: '', NODE_OPTIONS: '' }
  // Environment keys are case-insensitive on Windows; discard inherited Path.
  for (const name of Object.keys(env)) if (name !== 'PATH' && name.toUpperCase() === 'PATH') delete env[name]
  // Keep the OS shell available by absolute path while removing node from PATH.
  const shell = process.platform === 'win32' ? process.env.ComSpec || join(process.env.SystemRoot || 'C:/Windows', 'System32', 'cmd.exe') : '/bin/sh'
  const options = ['--ignore-scripts=false', '--foreground-scripts', `--script-shell=${shell}`,
    `--cache=${join(root, 'npm-cache')}`, '--registry=https://registry.npmjs.org/', '--no-audit', '--no-fund', '--package-lock=false']

  // Positive control: prove lifecycle scripts really cannot find node in this
  // environment. This prevents an npm PATH change from hiding the regression.
  const control = join(root, 'control')
  mkdirSync(control)
  writeFileSync(join(control, 'package.json'), JSON.stringify({ name: 'tabby-install-control', version: '1.0.0', scripts: { postinstall: 'node -e "process.exit(0)"' } }))
  successful(runNpm(['pack', '--ignore-scripts', '--pack-destination', root], control))
  const failed = runNpm(['install', join(root, 'tabby-install-control-1.0.0.tgz'), ...options], control, env)
  assert.ifError(failed.error)
  assert.notEqual(failed.status, 0, 'Positive control unexpectedly found node; installation regression check is invalid')
  assert.match(failed.stdout + failed.stderr, /node[^\r\n]*(?:not found|not recognized|could not be found|ENOENT)|(?:not found|not recognized)[^\r\n]*node/i)

  const destination = join(root, 'installed')
  mkdirSync(destination)
  writeFileSync(join(destination, 'package.json'), '{"private":true}')
  successful(runNpm(['install', archive, ...options], destination, env))
  const installed = join(destination, 'node_modules', manifest.name)
  const actual = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
  assert.equal(actual.version, manifest.version)
  for (const name of ['dist/index.js', 'dist/pi/sidecar.mjs', 'dist/pi/THIRD_PARTY_NOTICES.txt']) {
    assert.ok(readFileSync(join(installed, name)).length, `Missing packaged runtime: ${name}`)
  }
  // Inspect the entire installed production closure, not only root dependencies.
  const inspect = directory => {
    const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    assert.doesNotMatch(pkg.name, /(?:^@earendil-works\/pi-|^protobufjs$|^@google\/genai$)/)
    for (const hook of ['preinstall', 'install', 'postinstall']) assert.ok(!pkg.scripts?.[hook], `${pkg.name} has an install hook: ${hook}`)
    inspectModules(join(directory, 'node_modules'))
  }
  const inspectModules = modules => {
    if (!existsSync(modules)) return
    for (const entry of readdirSync(modules, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      if (entry.name.startsWith('@')) for (const name of readdirSync(join(modules, entry.name))) inspect(join(modules, entry.name, name))
      else inspect(join(modules, entry.name))
    }
  }
  inspectModules(join(destination, 'node_modules'))
  console.log(`PASS ${manifest.name}@${manifest.version}: actual tarball installs with no node on PATH and lifecycle scripts enabled`)
} finally { rmSync(root, { recursive: true, force: true }) }
