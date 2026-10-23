const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { AsyncSubject, Subject } = require('rxjs')
const ts = require('typescript')

const originalLoad = Module._load
const originalTsLoader = require.extensions['.ts']
Module._load = function (request, parent, isMain) {
  if (request === '@angular/core') return { Injectable: () => target => target }
  if (request === 'tabby-core') return {}
  return originalLoad.call(this, request, parent, isMain)
}
require.extensions['.ts'] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, experimentalDecorators: true },
  }).outputText
  module._compile(output, filename)
}
const { SUPPORTED_LANGUAGES, normalizeLanguage, setLanguage, getLanguage, textDirection, translate, onLanguageChange, formatDateTime } = require('../src/i18n.ts')
const { AgentI18nService } = require('../src/i18n.service.ts')
Module._load = originalLoad
require.extensions['.ts'] = originalTsLoader

const directory = path.join(__dirname, '../src/locales')
const catalog = language => require(path.join(directory, `${language}.json`))
const placeholders = value => (value.match(/\{\d+\}/g) || []).sort()
const ready = subject => { subject.next(true); subject.complete() }

test('all 12 shipped catalogs have complete, nonempty translations and preserve placeholders and product names', () => {
  const source = catalog('zh-CN')
  const keys = Object.keys(source).sort()
  assert.equal(SUPPORTED_LANGUAGES.length, 12)
  for (const { code } of SUPPORTED_LANGUAGES) {
    const data = catalog(code)
    assert.deepEqual(Object.keys(data).sort(), keys, `${code}: catalog coverage`)
    for (const key of keys) {
      assert.equal(typeof data[key], 'string', `${code}: ${key}`)
      assert.ok(data[key].trim(), `${code}: empty ${key}`)
      assert.deepEqual(placeholders(data[key]), placeholders(key), `${code}: placeholders in ${key}`)
      for (const brand of ['AI Tools', 'Tabby', 'Codex', 'codexAgent.executable', 'OpenAI', 'DeepSeek', 'GLM', 'Claude', 'Vault']) {
        if (key.includes(brand)) assert.ok(data[key].includes(brand), `${code}: preserve ${brand} in ${key}`)
      }
    }
  }
})

test('regional language tags normalize to supported catalogs with English fallback', () => {
  for (const [input, expected] of [
    ['en-GB', 'en'], ['es-MX', 'es'], ['pt_BR', 'pt'], ['fr-CA', 'fr'],
    ['zh-CN', 'zh-CN'], ['zh-SG', 'zh-CN'], ['zh_HK', 'zh-TW'], ['zh-Hant', 'zh-TW'],
    ['zh-Hant-TW', 'zh-TW'], ['ja-JP', 'ja'], ['ar-SA', 'ar'], ['hi-IN', 'hi'],
    ['unsupported', 'en'], ['', 'en'], [undefined, 'en'],
  ]) assert.equal(normalizeLanguage(input), expected, input)
})

test('language switching translates static and runtime messages and updates cached results', t => {
  t.after(() => setLanguage('en'))
  for (const { code } of SUPPORTED_LANGUAGES) {
    setLanguage(code)
    assert.equal(translate('发送'), catalog(code)['发送'])
    assert.equal(translate('每 {0} 分钟', [15]), catalog(code)['每 {0} 分钟'].replace('{0}', '15'))
    assert.equal(translate('每 15 分钟'), translate('每 {0} 分钟', [15]))
    assert.equal(translate('读取失败：disk offline'), catalog(code)['读取失败：{0}'].replace('{0}', 'disk offline'))
    assert.equal(getLanguage(), code)
    assert.equal(textDirection(), code === 'ar' ? 'rtl' : 'ltr')
  }
  setLanguage('en')
  assert.equal(translate('任务已完成'), 'Task completed')
  assert.equal(translate('每 15 分钟'), 'every 15 minutes')
})

test('missing translations fall back to English and unknown diagnostic data stays intact', t => {
  const data = catalog('es')
  const saved = data['任务已完成']
  t.after(() => { data['任务已完成'] = saved; setLanguage('en') })
  delete data['任务已完成']
  setLanguage('es')
  assert.equal(translate('任务已完成'), 'Task completed')
  assert.equal(translate('Custom model output: 原文 abc 123'), 'Custom model output: 原文 abc 123')
  assert.equal(translate('toString'), 'toString')
  assert.equal(translate(undefined), '')
})

test('interpolation preserves user content without recursively translating or substituting it', t => {
  t.after(() => setLanguage('en'))
  setLanguage('fr')
  const title = '任务已完成 {1} <script> & $&'
  const source = '确认删除“{0}”及其执行记录？删除后不再触发，无法恢复。'
  assert.equal(translate(source, [title]), catalog('fr')[source].replace('{0}', () => title))
  assert.equal(translate('每 {0} 分钟'), catalog('fr')['每 {0} 分钟'])
})

test('composed runtime labels translate owned fragments while keeping model IDs and errors intact', t => {
  t.after(() => setLanguage('en'))
  for (const { code } of SUPPORTED_LANGUAGES.filter(item => !['zh-CN', 'zh-TW', 'ja'].includes(item.code))) {
    setLanguage(code)
    for (const source of [
      '无人值守 · 不询问 · 只读',
      '模型已设为 user-model-v2 · 推理强度 默认，下一回合生效',
      '测试成功：user-model-v2 · 123 ms · 收到 2 个正文流片段',
      '已用 25% · 10/23 15:00 重置',
      '新建失败：disk offline；原会话仍可用',
      '连接失败：disk offline',
      '发送失败：disk offline\nCodex 正在自动重试…',
    ]) assert.doesNotMatch(translate(source), /\p{Script=Han}/u, `${code}: ${source}`)
    assert.ok(translate('模型已设为 user-model-v2 · 推理强度 默认，下一回合生效').includes('user-model-v2'))
    assert.ok(translate('新建失败：disk offline；原会话仍可用').includes('disk offline'))
  }
})

test('language change listeners unsubscribe and date formatting uses the selected language', t => {
  t.after(() => setLanguage('en'))
  setLanguage('en')
  const changes = []
  const stop = onLanguageChange(() => changes.push(getLanguage()))
  setLanguage('ar-SA')
  setLanguage('ar')
  assert.deepEqual(changes, ['ar'])
  const time = Date.UTC(2026, 9, 23, 12, 30)
  assert.equal(formatDateTime(time), new Date(time).toLocaleString('ar'))
  stop()
  setLanguage('de')
  assert.deepEqual(changes, ['ar'])
})

test('the language service follows Tabby, persists independent overrides, and cleans up listeners', t => {
  t.after(() => setLanguage('en'))
  setLanguage('en')
  const config = { ready$: new AsyncSubject(), changed$: new Subject(), store: { codexAgent: { language: 'auto' } } }
  let hostLanguage = 'fr-FR'
  const locale = { localeChanged$: new Subject(), getLocale: () => hostLanguage }
  const service = new AgentI18nService(config, locale, { run: fn => fn() })
  t.after(() => service.ngOnDestroy())
  service.start()
  service.start()
  assert.equal(config.changed$.observers.length, 1)
  assert.equal(getLanguage(), 'en')
  ready(config.ready$)
  assert.equal(getLanguage(), 'fr')
  hostLanguage = 'ja-JP'
  locale.localeChanged$.next(hostLanguage)
  assert.equal(getLanguage(), 'ja')
  config.store.codexAgent.language = 'ar'
  config.changed$.next()
  assert.equal(getLanguage(), 'ar')
  hostLanguage = 'de-DE'
  locale.localeChanged$.next(hostLanguage)
  assert.equal(getLanguage(), 'ar')
  config.store.codexAgent.language = 'auto'
  config.changed$.next()
  assert.equal(getLanguage(), 'de')
  service.ngOnDestroy()
  hostLanguage = 'ko-KR'
  locale.localeChanged$.next(hostLanguage)
  config.changed$.next()
  assert.equal(getLanguage(), 'de')
  assert.equal(config.changed$.observers.length, 0)
  assert.equal(locale.localeChanged$.observers.length, 0)
})

test('localized Pug templates parse as Angular templates without translating user or model messages', async () => {
  const { parseTemplate } = await import('@angular/compiler')
  const pug = require('pug')
  for (const file of ['codex-panel.component.pug', 'settings.pug']) {
    const source = fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')
    const html = pug.render(source)
    const result = parseTemplate(html, file)
    assert.equal(result.errors, null, result.errors?.map(error => error.toString()).join('\n'))
    assert.match(html, /\[attr.dir\]="direction"/)
    assert.match(html, /\[attr.lang\]="languageCode"/)
    // Inspect Angular's actual expression AST, including escaped attributes and
    // nested interpolation, so unshipped keys fail before release.
    const seen = new WeakSet()
    let keys = 0
    function visit (node) {
      if (!node || typeof node !== 'object' || seen.has(node)) return
      seen.add(node)
      if (node.receiver?.name === 't' && typeof node.args?.[0]?.value === 'string') {
        const key = node.args[0].value
        assert.ok(Object.hasOwn(catalog('en'), key), `${file}: missing ${key}`)
        keys++
      }
      if (node.constructor.name === 'Text') assert.doesNotMatch(node.value, /\p{Script=Han}/u, `${file}: untranslated text`)
      for (const value of Object.values(node)) visit(value)
    }
    visit(result.nodes)
    assert.ok(keys > 100, `${file}: inspect translated expressions`)
  }
  const panel = fs.readFileSync(path.join(__dirname, '../src/codex-panel.component.pug'), 'utf8')
  assert.match(panel, /entry.kind === "system" \? t\(entry.text\) : entry.text/)
  assert.doesNotMatch(panel, /{{t\((?:question.question|option.description|task.title|profile.name)\)}}/)
})
