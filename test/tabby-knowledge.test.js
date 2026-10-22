const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

async function fixture (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tabby-knowledge-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'skills/tabby/references'), { recursive: true })
  await fs.mkdir(path.join(root, 'src'))
  await fs.copyFile(path.join(__dirname, '../skills/tabby/SKILL.md'), path.join(root, 'skills/tabby/SKILL.md'))
  await fs.copyFile(path.join(__dirname, '../skills/tabby/references/operations.md'), path.join(root, 'skills/tabby/references/operations.md'))
  return root
}

test('weekly sync pins every source to one commit and does not produce timestamp-only updates', async t => {
  const { updateTabbyKnowledge, sourcePaths } = await import('../scripts/update-tabby-knowledge.mjs')
  const directory = await fixture(t)
  const urls = []
  const fetchSource = async url => {
    urls.push(url)
    if (url.endsWith('/commits/master')) return { sha: 'a'.repeat(40) }
    return { encoding: 'base64', content: Buffer.from('export class Host { open (): void {} }').toString('base64') }
  }
  assert.equal(await updateTabbyKnowledge({ directory, fetchSource }), true)
  const snapshotPath = path.join(directory, 'skills/tabby/references/upstream.json')
  const bundlePath = path.join(directory, 'src/tabby-knowledge.json')
  const before = await fs.readFile(snapshotPath, 'utf8')
  const snapshot = JSON.parse(before)
  assert.equal(snapshot.sources.length, sourcePaths.length)
  assert.ok(urls.slice(1).every(url => url.endsWith(`?ref=${'a'.repeat(40)}`)))
  assert.ok(snapshot.sources.every(source => /^[a-f0-9]{64}$/.test(source.sha256)))
  const bundle = JSON.parse(await fs.readFile(bundlePath, 'utf8'))
  assert.equal(bundle.upstream.commit, snapshot.commit)
  assert.ok(bundle.skill.includes('Tabby application skill'))
  assert.equal(await updateTabbyKnowledge({ directory, fetchSource }), false)
  assert.equal(await fs.readFile(snapshotPath, 'utf8'), before)
})

test('failed upstream requests leave the previous snapshot and bundle intact', async t => {
  const { updateTabbyKnowledge } = await import('../scripts/update-tabby-knowledge.mjs')
  const directory = await fixture(t)
  const snapshotPath = path.join(directory, 'skills/tabby/references/upstream.json')
  const bundlePath = path.join(directory, 'src/tabby-knowledge.json')
  await fs.writeFile(snapshotPath, 'previous snapshot')
  await fs.writeFile(bundlePath, 'previous bundle')
  const fetchSource = async url => {
    if (url.endsWith('/commits/master')) return { sha: 'a'.repeat(40) }
    throw new Error('upstream unavailable')
  }
  await assert.rejects(updateTabbyKnowledge({ directory, fetchSource }), /upstream unavailable/)
  assert.equal(await fs.readFile(snapshotPath, 'utf8'), 'previous snapshot')
  assert.equal(await fs.readFile(bundlePath, 'utf8'), 'previous bundle')
})

test('API summaries expose public operations without executing or copying method implementations', async () => {
  const { summarizeSource } = await import('../scripts/update-tabby-knowledge.mjs')
  const summary = summarizeSource('host.ts', 'export class Host { private hidden (): void {}\n public open (id: string): Promise<void> { throw new Error("body must not be copied") } }')
  assert.match(summary.api, /open \(id: string\): Promise<void>/)
  assert.doesNotMatch(summary.api, /hidden|body must not be copied/)
})

for (const sourceEol of ['\n', '\r\n']) {
  for (const targetEol of ['\n', '\r\n']) {
    test(`skill bundle checks semantic source/target EOL ${JSON.stringify([sourceEol, targetEol])} and rejects stale content`, async t => {
      const { bundleTabbySkill } = await import('../scripts/bundle-tabby-skill.mjs')
      const directory = await fixture(t)
      const skill = path.join(directory, 'skills/tabby/SKILL.md')
      const operations = path.join(directory, 'skills/tabby/references/operations.md')
      await fs.copyFile(path.join(__dirname, '../skills/tabby/references/upstream.json'), path.join(directory, 'skills/tabby/references/upstream.json'))
      await bundleTabbySkill(directory, false)
      const target = path.join(directory, 'src/tabby-knowledge.json')
      const canonical = await fs.readFile(target, 'utf8')
      for (const file of [skill, operations]) await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace(/\r?\n/g, sourceEol))
      await fs.writeFile(target, canonical.replace(/\r?\n/g, targetEol))
      await bundleTabbySkill(directory, true)
      await bundleTabbySkill(directory, false)
      assert.equal(await fs.readFile(target, 'utf8'), canonical)
      await fs.appendFile(operations, `${sourceEol}Real source change.${sourceEol}`)
      await assert.rejects(bundleTabbySkill(directory, true), /stale/)
      await bundleTabbySkill(directory, false)
      await bundleTabbySkill(directory, true)
      const changed = await fs.readFile(target, 'utf8')
      await fs.writeFile(target, changed.replace('Real source change.', 'Stale bundle text.'))
      await assert.rejects(bundleTabbySkill(directory, true), /stale/)
    })
  }
}

test('skill check passes a real core.autocrlf=true temporary Git checkout', async t => {
  const { execFileSync } = require('node:child_process')
  const { bundleTabbySkill } = await import('../scripts/bundle-tabby-skill.mjs')
  const directory = await fixture(t)
  await fs.copyFile(path.join(__dirname, '../skills/tabby/references/upstream.json'), path.join(directory, 'skills/tabby/references/upstream.json'))
  await bundleTabbySkill(directory, false)
  const git = args => execFileSync('git', ['--no-pager', '-C', directory, '-c', 'core.autocrlf=true', ...args], { stdio: 'pipe' })
  git(['init', '--quiet'])
  git(['add', 'skills', 'src']) // Temporary index only; no commit or project index mutation.
  for (const file of ['skills/tabby/SKILL.md', 'skills/tabby/references/operations.md', 'skills/tabby/references/upstream.json', 'src/tabby-knowledge.json']) await fs.unlink(path.join(directory, file))
  git(['checkout-index', '--all'])
  assert.match(await fs.readFile(path.join(directory, 'skills/tabby/SKILL.md'), 'utf8'), /\r\n/)
  assert.match(await fs.readFile(path.join(directory, 'src/tabby-knowledge.json'), 'utf8'), /\r\n/)
  await bundleTabbySkill(directory, true)
})
