const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const ts = require('typescript')
const original = Module._load
Module._load = function (name, parent, main) {
  if (name === '@angular/core') return { Component: () => x => x, Injectable: () => x => x }
  if (name === 'tabby-core' || name === 'tabby-terminal') return {}
  if (name === 'tabby-settings') return { SettingsTabProvider: class {} }
  return original.call(this, name, parent, main)
}
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true, experimentalDecorators: true } }).outputText, filename)
require.extensions['.pug'] = module => { module.exports = '' }
require.extensions['.css'] = module => { module.exports = '' }
const { CodexSettingsComponent } = require('../src/settings.ts')
const { validatePiProfile, piModels } = require('../src/pi-config.ts')
const { profileFingerprint } = require('../src/agent-store.ts')
Module._load = original
const profile = { id: 'existing', name: 'existing', provider: 'custom', baseUrl: 'http://localhost:1234/v1', model: 'fixture', keySource: 'direct', apiKey: 'saved-secret', thinking: 'default', reasoningEffort: '', contextWindow: 8000, maxOutputTokens: 512, maxIterations: 0, threads: { '/project': 'history' } }
function fixture () {
  let saves = 0, fail = false
  const config = { store: { codexAgent: { defaultProfileId: 'existing', apiProfiles: [structuredClone(profile)] } }, save: async () => { saves++; if (fail) throw new Error('disk') } }
  const component = new CodexSettingsComponent(config, { read: async () => '' }, { run: fn => fn() })
  return { component, config, saves: () => saves, fail: () => { fail = true } }
}
test('connection edits and provider changes remain drafts; switching back retains drafts; discard restores history and credentials', () => {
  const f = fixture(), c = f.component
  c.selectedProfile.baseUrl = 'https://different.example/v1'; c.draftChanged(c.selectedProfile)
  c.addProfile()
  assert.equal(c.selectedProfile.runtime, 'pi'); assert.equal(c.selectedProfile.piConnection.mode, 'native')
  assert.equal(f.config.store.codexAgent.apiProfiles.length, 1)
  c.discardDraft(c.selectedProfile)
  c.selectProfile('existing')
  assert.equal(c.selectedProfile.baseUrl, 'https://different.example/v1')
  c.discardDraft(c.selectedProfile)
  assert.deepEqual(c.selectedProfile, profile); assert.equal(f.saves(), 0)
})
test('saving writes a detached connection; failure retains draft and original configuration', async () => {
  const f = fixture(), c = f.component
  c.selectedProfile.name = 'saved name'; await c.saveDraft(c.selectedProfile)
  assert.equal(f.config.store.codexAgent.apiProfiles[0].name, 'saved name')
  c.selectedProfile.name = 'draft after save'
  assert.equal(f.config.store.codexAgent.apiProfiles[0].name, 'saved name')
  f.fail(); await c.saveDraft(c.selectedProfile)
  assert.equal(f.config.store.codexAgent.apiProfiles[0].name, 'saved name')
  assert.equal(c.selectedProfile.name, 'draft after save'); assert.match(c.draftNotice, /retained/)
})
test('copy isolates ID, history and test status; SDK catalog needs no credential or HTTP request', async () => {
  const { component: c, config } = fixture()
  c.connectionTests.existing = { running: false, notice: 'previous success' }
  c.copyProfile(c.selectedProfile)
  assert.notEqual(c.selectedProfile.id, 'existing'); assert.deepEqual(c.selectedProfile.threads, {})
  assert.equal(c.connectionTests[c.selectedProfile.id], undefined)
  c.changeRuntime(c.selectedProfile, 'pi'); c.changePiMode(c.selectedProfile, 'native')
  c.selectedProfile.model = 'gemini-2.5-flash'
  await c.fetchModels(c.selectedProfile)
  assert.ok(c.modelLists[c.selectedProfile.id].models.some(m => m.model === 'gemini-2.5-flash'))
  assert.equal(config.store.codexAgent.apiProfiles.length, 1)
})
test('native capabilities validate output and reasoning; unknown/manual models require explicit protocol and limits', () => {
  const p = { ...profile, runtime: 'pi', baseUrl: '', model: 'gemini-2.5-flash', piConnection: { version: 1, mode: 'native', providerId: 'google' } }
  validatePiProfile(p)
  assert.ok(piModels(p).length)
  assert.throws(() => validatePiProfile({ ...p, maxOutputTokens: 1000000 }), /budget/)
  assert.throws(() => validatePiProfile({ ...p, reasoningEffort: 'nonsense' }), /thinking/)
  assert.throws(() => validatePiProfile({ ...p, model: 'new-model' }), /protocol/)
  assert.throws(() => validatePiProfile({ ...p, baseUrl: 'http://example.com' }), /HTTPS/)
  assert.throws(() => validatePiProfile({ ...p, piConnection: { version: 1, mode: 'native', providerId: 'google-vertex' } }), /identity/)
})
test('legacy fingerprint is stable, native protocol/provider identity is distinct, credentials do not remove history', () => {
  const { createHash } = require('node:crypto')
  const old = createHash('sha256').update(JSON.stringify([profile.id, profile.provider, profile.baseUrl, profile.model, 'chat-completions'])).digest('hex')
  assert.equal(profileFingerprint(profile), old)
  const p = { ...profile, runtime: 'pi', piConnection: { version: 1, mode: 'custom', api: 'google-generative-ai' } }
  assert.notEqual(profileFingerprint(p), profileFingerprint({ ...p, piConnection: { ...p.piConnection, api: 'anthropic-messages' } }))
  assert.equal(profileFingerprint(p), profileFingerprint({ ...p, apiKey: 'changed' }))
})

test('switching providers restores independent inputs and never carries a key into a new provider', () => {
  const { component: c } = fixture()
  const p = c.selectedProfile
  c.changeRuntime(p, 'pi'); c.changePiMode(p, 'native')
  p.model = 'gemini-2.5-flash'; p.apiKey = 'gemini-only'; p.baseUrl = 'https://gemini.example/v1beta'
  c.changePiProvider(p, 'openrouter')
  assert.equal(p.apiKey, ''); assert.equal(p.apiKeyEnv, '')
  p.model = 'openai/gpt-4o-mini'; p.apiKey = 'router-only'
  c.changePiProvider(p, 'google')
  assert.equal(p.apiKey, 'gemini-only'); assert.equal(p.model, 'gemini-2.5-flash'); assert.equal(p.baseUrl, 'https://gemini.example/v1beta')
  c.changePiProvider(p, 'openrouter')
  assert.equal(p.apiKey, 'router-only')
  c.discardDraft(p)
  c.changeRuntime(c.selectedProfile, 'pi'); c.changePiMode(c.selectedProfile, 'native')
  assert.equal(c.selectedProfile.apiKey, '')
})

test('saving a connection draft preserves thread references created by another sidebar', async () => {
  const { component: c, config } = fixture()
  c.selectedProfile.name = 'new name'
  config.store.codexAgent.apiProfiles[0].threads['/new-project'] = 'created-while-editing'
  await c.saveDraft(c.selectedProfile)
  assert.equal(config.store.codexAgent.apiProfiles[0].threads['/new-project'], 'created-while-editing')
  assert.equal(c.dirty, false)
})

test('Pi output budgets follow SDK capabilities beyond the legacy API cap', () => {
  const { normalizeApiProfile } = require('../src/agent-types.ts')
  const { piCatalog } = require('../src/pi-config.ts')
  const provider = piCatalog.providers.find(p => !p.unavailableReason && p.models.some(m => m.maxTokens >= 200000))
  const model = provider.models.find(m => m.maxTokens >= 200000)
  const p = { ...profile, runtime: 'pi', baseUrl: '', model: model.id, maxOutputTokens: 200000, piConnection: { version: 1, mode: 'native', providerId: provider.id } }
  validatePiProfile(p)
  assert.equal(normalizeApiProfile(p).maxOutputTokens, 200000)
  assert.equal(normalizeApiProfile({ ...profile, maxOutputTokens: 200000 }).maxOutputTokens, 131072)
})
