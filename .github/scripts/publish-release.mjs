import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const repository = 'Hanlen/tabby-ai-tools'
export const packageName = 'tabby-ai-tools'
export function versionFromTag (tag) {
  assert.match(tag || '', /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Only stable vMAJOR.MINOR.PATCH releases can publish latest')
  assert.equal(tag, tag.trim(), 'Release tags cannot contain surrounding whitespace')
  return tag.slice(1)
}
export function verifyChecks (runs, jobs, sha, tag) {
  return ['main', tag].map(branch => {
    const run = runs.find(run => run.head_sha === sha && run.head_branch === branch && run.event === 'push' && run.path === '.github/workflows/check.yml')
    assert.ok(run && run.status === 'completed' && run.conclusion === 'success', `${branch} CI has not passed for the release commit`)
    const matrix = jobs[run.id] || []
    assert.equal(matrix.length, 3, `${branch} CI matrix is incomplete`)
    for (const os of ['ubuntu-latest', 'macos-latest', 'windows-latest']) {
      assert.ok(matrix.some(job => job.name === `check (${os})` && job.conclusion === 'success'), `${branch}: ${os} has not passed`)
    }
    return run.html_url
  })
}
export function verifyManifest (manifest, version) {
  assert.equal(manifest.name, packageName)
  assert.equal(manifest.version, version)
  assert.equal(manifest.main, 'dist/index.js')
  assert.equal(manifest.repository?.url, `git+https://github.com/${repository}.git`)
  for (const hook of ['preinstall', 'install', 'postinstall']) assert.ok(!manifest.scripts?.[hook], `Unexpected package install hook: ${hook}`)
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) assert.ok(!name.startsWith('@earendil-works/pi-'), 'Pi must remain bundled, not installed at runtime')
}
export function verifyArchiveNames (names) {
  for (const name of names) {
    assert.ok(name.startsWith('package/') && !name.split('/').includes('..') && !name.includes('\\'), 'Unsafe archive path')
    assert.ok(!/(?:AGENTS\.md|roadmap|research|(?:^|\/)node_modules\/|(?:^|\/)\.env|(?:^|\/)\.npmrc|(?:^|\/)\.git\/)/i.test(name), `Unexpected private/package content: ${name}`)
  }
  for (const file of ['package.json', 'dist/index.js', 'dist/pi/sidecar.mjs', 'dist/pi/electron-host.cjs', 'dist/pi/THIRD_PARTY_NOTICES.txt', 'README.md', 'README.zh-CN.md', 'docs/assets/overview.png', 'docs/assets/overview.svg', 'docs/assets/robot-multitask.gif', 'docs/assets/robot-multitask.png', 'skills/tabby/SKILL.md']) assert.ok(names.includes('package/' + file), `Missing artifact: ${file}`)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function github (path) {
  const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, { headers: {
    Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
    ...(process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {}),
  } })
  assert.ok(response.ok, `GitHub API HTTP ${response.status}`)
  return response.json()
}
async function registry (suffix) {
  const response = await fetch(`https://registry.npmjs.org/${packageName}/${suffix}`, { cache: 'no-store' })
  if (response.status === 404) return undefined
  assert.ok(response.ok, `npm registry HTTP ${response.status}`)
  return response.json()
}
export async function main () {
  assert.equal(process.env.GITHUB_REPOSITORY || repository, repository)
  const tag = process.env.RELEASE_TAG
  const version = versionFromTag(tag)
  const dryRun = process.env.RELEASE_DRY_RUN === 'true'
  const ref = await github(`git/ref/tags/${tag}`)
  assert.equal(ref.object.type, 'tag', 'Release tag must be annotated')
  const annotation = await github(`git/tags/${ref.object.sha}`)
  assert.equal(annotation.object.type, 'commit')
  const sha = annotation.object.sha
  const { workflow_runs: runs } = await github(`actions/runs?head_sha=${sha}&event=push&per_page=100`)
  const jobs = {}
  for (const branch of ['main', tag]) {
    const run = runs.find(run => run.head_branch === branch && run.path === '.github/workflows/check.yml')
    if (run) jobs[run.id] = (await github(`actions/runs/${run.id}/jobs?per_page=100`)).jobs
  }
  const ci = verifyChecks(runs, jobs, sha, tag)
  const name = `${packageName}-${version}.tgz`
  let release, asset
  for (let attempt = 0; attempt < 25; attempt++) {
    release = await github(`releases/tags/${tag}`)
    assert.ok(!release.draft && !release.prerelease && release.tag_name === tag, 'A published stable GitHub Release is required')
    asset = release.assets.find(asset => asset.name === name && asset.state === 'uploaded')
    if (asset) break
    await sleep(5000)
  }
  assert.ok(asset, 'Verified release tarball attachment is missing')
  assert.ok(asset.browser_download_url.startsWith(`https://github.com/${repository}/releases/download/${tag}/`))
  const response = await fetch(asset.browser_download_url)
  assert.ok(response.ok, `Artifact download HTTP ${response.status}`)
  const data = Buffer.from(await response.arrayBuffer())
  const sha256 = createHash('sha256').update(data).digest('hex')
  const integrity = 'sha512-' + createHash('sha512').update(data).digest('base64')
  assert.equal(asset.digest, 'sha256:' + sha256, 'GitHub asset checksum differs')
  assert.ok(release.body.includes(sha256), 'Reviewed tarball checksum is missing from release notes')
  const directory = mkdtempSync(join(tmpdir(), 'tabby-trusted-publish-'))
  const tarball = join(directory, name)
  writeFileSync(tarball, data)
  const names = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n')
  verifyArchiveNames(names)
  verifyManifest(JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' })), version)
  const existing = await registry(version)
  if (existing) {
    assert.equal(existing.dist.integrity, integrity, 'Existing npm version differs; versions cannot be overwritten')
    console.log(`${version} is already published with identical integrity; no publish request sent.`)
    return { version, sha, sha256, integrity, alreadyPublished: true }
  }
  const latest = await registry('latest')
  if (latest) {
    const next = version.split('.').map(Number), previous = latest.version.split('.').map(Number)
    const index = next.findIndex((value, i) => value !== previous[i])
    assert.ok(index >= 0 && next[index] > previous[index], 'Refusing to move latest backward')
  }
  console.log(JSON.stringify({ tag, sha, tarball, sha256, integrity, ci, dryRun }))
  if (dryRun) return { version, sha, sha256, integrity, dryRun: true }
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Publishing must run in GitHub Actions')
  assert.ok(process.env.ACTIONS_ID_TOKEN_REQUEST_URL, 'OIDC permission id-token: write is required')
  assert.ok(!process.env.NODE_AUTH_TOKEN && !process.env.NPM_TOKEN, 'Use OIDC rather than stored npm tokens')
  const config = join(directory, 'npmrc')
  writeFileSync(config, 'registry=https://registry.npmjs.org/\n')
  const published = spawnSync('npm', ['publish', tarball, '--access', 'public', '--tag', 'latest', '--registry=https://registry.npmjs.org/', '--browser=false', '--no-progress'], {
    env: { ...process.env, NPM_CONFIG_USERCONFIG: config }, stdio: 'inherit', shell: false, timeout: 120000,
  })
  assert.ifError(published.error)
  assert.equal(published.status, 0, 'OIDC publishing failed; check the npm trusted publisher binding for publish.yml')
  console.log('npm accepted the package. Waiting for registry processing; this version will not be republished.')
  for (let attempt = 0; attempt < 120; attempt++) {
    const current = await registry(version), currentLatest = await registry('latest')
    if (current) {
      assert.equal(current.dist.integrity, integrity)
      if (currentLatest?.version === version) {
        const downloaded = Buffer.from(await (await fetch(current.dist.tarball)).arrayBuffer())
        assert.ok(downloaded.equals(data), 'npm tarball differs from the verified GitHub attachment')
        const summary = `Published **${packageName}@${version}** with GitHub OIDC.\n\nCommit: ${sha}\n\nSHA-256: ${sha256}\n\nRegistry latest and downloaded artifact verified.\n`
        console.log(summary)
        if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
        return { version, sha, sha256, integrity, published: true }
      }
    }
    await sleep(15000)
  }
  throw new Error('npm accepted the package but registry processing is still pending; do not republish this version')
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
