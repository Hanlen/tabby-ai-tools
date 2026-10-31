const test = require('node:test')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const path = require('node:path')
const policy = import(pathToFileURL(path.resolve(__dirname, '../.github/scripts/publish-release.mjs')).href)

test('release publishing accepts stable tags and rejects arbitrary or prerelease refs', async () => {
  const { versionFromTag } = await policy
  assert.equal(versionFromTag('v0.5.2'), '0.5.2')
  for (const value of ['', 'main', 'v0.5.2-beta.1', 'v01.2.3', 'v1.2.3/../../main', 'v1.2.3\n']) assert.throws(() => versionFromTag(value))
})
const runs = () => ['main', 'v0.5.2'].map((branch, index) => ({ id: index, head_sha: 'release-sha', head_branch: branch, event: 'push', path: '.github/workflows/check.yml', status: 'completed', conclusion: 'success', html_url: `https://github.com/example/${index}` }))
const jobs = () => Object.fromEntries([0, 1].map(id => [id, ['ubuntu-latest', 'macos-latest', 'windows-latest'].map(os => ({ name: `check (${os})`, conclusion: 'success' }))]))

test('release publishing requires both exact-commit three-platform CI results', async () => {
  const { verifyChecks } = await policy
  assert.equal(verifyChecks(runs(), jobs(), 'release-sha', 'v0.5.2').length, 2)
  for (const mutate of [r => { r[0].head_sha = 'other-commit' }, r => { r[1].status = 'in_progress' }, r => { r[0].path = '.github/workflows/other.yml' }]) {
    const value = runs(); mutate(value)
    assert.throws(() => verifyChecks(value, jobs(), 'release-sha', 'v0.5.2'))
  }
})

test('release publishing rejects a failed or missing Windows job', async () => {
  const { verifyChecks } = await policy
  const failed = jobs(); failed[1][2].conclusion = 'failure'
  assert.throws(() => verifyChecks(runs(), failed, 'release-sha', 'v0.5.2'))
  failed[1].pop()
  assert.throws(() => verifyChecks(runs(), failed, 'release-sha', 'v0.5.2'))
})

test('release artifact identity cannot redirect publication or add installation hooks', async () => {
  const { verifyManifest } = await policy
  const manifest = { name: 'tabby-ai-tools', version: '0.5.2', main: 'dist/index.js', repository: { url: 'git+https://github.com/Hanlen/tabby-ai-tools.git' }, dependencies: { 'cross-spawn': '^7.0.6' } }
  verifyManifest(manifest, '0.5.2')
  for (const change of [{ name: 'another-package' }, { version: '0.5.1' }, { repository: { url: 'git+https://github.com/other/repo.git' } }, { scripts: { postinstall: 'node install' } }, { optionalDependencies: { '@earendil-works/pi-ai': '1.4.0' } }]) assert.throws(() => verifyManifest({ ...manifest, ...change }, '0.5.2'))
})

test('release artifacts reject traversal and local instructions or research', async () => {
  const { verifyArchiveNames } = await policy
  const files = ['package.json', 'dist/index.js', 'dist/pi/sidecar.mjs', 'dist/pi/electron-host.cjs', 'dist/pi/THIRD_PARTY_NOTICES.txt', 'README.md', 'README.zh-CN.md', 'docs/assets/overview.png', 'docs/assets/overview.svg', 'docs/assets/robot-multitask.gif', 'docs/assets/robot-multitask.png', 'skills/tabby/SKILL.md'].map(name => 'package/' + name)
  verifyArchiveNames(files)
  for (const entry of ['../package.json', 'package/../credentials', 'package/AGENTS.md', 'package/research/plan.md', 'package/.npmrc', 'package/docs/provider-roadmap.md', 'package/node_modules/example/package.json']) assert.throws(() => verifyArchiveNames([...files, entry]))
})
