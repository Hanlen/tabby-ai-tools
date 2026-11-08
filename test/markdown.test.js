const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const Module = require('node:module')
const ts = require('typescript')

const load = Module._load, extension = require.extensions['.ts']
Module._load = function (request, ...args) {
  if (request === '@angular/core') return {
    Component: () => value => value, Input: () => () => {},
    ViewEncapsulation: { None: 2 }, ChangeDetectionStrategy: { OnPush: 0 },
  }
  if (request === 'tabby-core' || request.endsWith('.css')) return {}
  return load.call(this, request, ...args)
}
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, experimentalDecorators: true, esModuleInterop: true },
}).outputText, filename)
const { renderMarkdown, markdownExternalUrl } = require('../src/markdown.ts')
const { MarkdownComponent } = require('../src/markdown.component.ts')
const { setLanguage } = require('../src/i18n.ts')
Module._load = load; require.extensions['.ts'] = extension
const html = source => renderMarkdown(source).map(block => block.html).join('')
const withoutHighlight = result => result.replace(/<span class="[\w -]+">|<\/span>/g, '')

test('assistant Markdown renders tables, alignment and common prose without inline styles', () => {
  const result = html('# Results\n\n**Good** and *clear*, ~~old~~, `code`.\nNext line\n\n> Note\n\n1. First\n2. Second\n\n| Name | Value |\n| :--- | ---: |\n| app | **OK** |')
  for (const expected of ['<h1>Results</h1>', '<strong>Good</strong>', '<em>clear</em>', '<s>old</s>', '<code>code</code>', '<br>', '<blockquote>', '<ol>', '<table>', '<thead>', '<tbody>', 'scope="col"', 'codex-md-align-right']) assert.ok(result.includes(expected), expected)
  assert.doesNotMatch(result, /style=/)
  assert.match(renderMarkdown('| A |\n| - |\n| B |', '表格')[0].html, /aria-label="表格"/)
})

test('fenced, indented and nested code remains escaped and copyable as plain code text', () => {
  for (const source of ['```html\n<script>run()</script>\n```', '    <script>run()</script>', '> ```html\n> <script>run()</script>\n> ```', '- Example\n\n  ```html\n  <script>run()</script>\n  ```']) {
    const result = html(source)
    assert.match(withoutHighlight(result), /<pre><code(?: class="language-html")?>&lt;script&gt;run\(\)&lt;\/script&gt;\n<\/code><\/pre>/)
    assert.doesNotMatch(result, /<script>/)
  }
})

test('explicit code languages and aliases receive safe token markup, including Markdown', () => {
  const samples = {
    js: 'const count = 42; // comment', ts: 'const count: number = 42;',
    python: 'def greet():\n  return "hello"', sh: 'echo "$HOME"',
    json: '{"count":42}', yml: 'enabled: true', html: '<div title="ok">hello</div>',
    css: '.item { color: red; }', sql: 'SELECT * FROM users;',
    md: '# Heading\n\n**bold** and `code`', ps1: 'Write-Host "hello"',
    dockerfile: 'FROM node:22\nRUN echo "hello"',
  }
  for (const [language, code] of Object.entries(samples)) {
    const result = html('```' + language + '\n' + code + '\n```')
    assert.match(result, /<span class="hljs-[\w -]+">/, language)
    assert.doesNotMatch(result, /style=|<script\b|<div title=/, language)
    assert.equal(withoutHighlight(result).replace(/^<pre><code[^>]*>|<\/code><\/pre>\n$/g, ''), code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;') + '\n', language)
  }
  assert.match(html('```JS extra-info\nconst n = 42\n```'), /hljs-keyword/)
})

test('unknown, unlabeled, plain and oversized code falls back to escaped readable text', () => {
  for (const language of ['', 'unknown-language', 'text', 'plaintext']) {
    const result = html('```' + language + '\n<script>alert("x")</script>\n```')
    assert.doesNotMatch(result, /hljs-|<script>/)
    assert.match(result, /&lt;script&gt;/)
  }
  const result = html('```js\nconst value = "<script>";\n' + 'x'.repeat(20000) + '\n```')
  assert.doesNotMatch(result, /hljs-|<script>/)
  assert.match(result, /&lt;script&gt;/)
})

test('highlighting escapes hostile code and incomplete streamed code preserves its text', () => {
  const code = 'const value = "<img src=x onerror=alert(1)>";\n// </code><script>alert(1)</script>'
  for (let length = 0; length <= code.length; length++) {
    const result = html('```js\n' + code.slice(0, length))
    assert.doesNotMatch(result, /<(?:img|script)\b|style=/)
    assert.doesNotMatch(withoutHighlight(result), /<(?:img|script)\b/)
  }
  assert.equal(withoutHighlight(html('```js\n' + code + '\n```')), '<pre><code class="language-js">' + code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;') + '\n</code></pre>\n')
})

test('every partial streaming prefix renders safely and the final source determines the result', () => {
  const source = '## 测试\n\n| Name | Value |\n| --- | ---: |\n| app | ready |\n\n```sh\nprintf "<done>"\n```\n\n[Docs](https://example.com/docs)'
  for (let i = 0; i <= source.length; i++) {
    const blocks = renderMarkdown(source.slice(0, i))
    assert.ok(blocks.every(block => typeof block.html === 'string'))
    assert.doesNotMatch(blocks.map(block => block.html).join(''), /<done>/)
  }
  assert.match(html(source), /<table>/)
  assert.match(html(source), /language-sh/)
  assert.match(html(source), /href="https:\/\/example.com\/docs"/)
})

test('unchanged root blocks retain identical HTML while the current block grows', () => {
  const first = renderMarkdown('Intro\n\n```js\nconst value = 1\n```\n\nNow')
  const second = renderMarkdown('Intro\n\n```js\nconst value = 1\n```\n\nNow streaming')
  assert.deepEqual(first.slice(0, 2), second.slice(0, 2))
  assert.notDeepEqual(first[2], second[2])
  const refs = html('[Docs][ref]\n\n[ref]: https://example.com')
  assert.match(refs, /href="https:\/\/example.com\/"/)
})

test('model HTML, unsafe schemes and image URLs cannot create active content or image requests', () => {
  const source = '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<iframe src="https://example.com"></iframe>\n\n[bad](javascript:alert%281%29) [encoded](jav&#x61;script:alert%281%29) [file](file:///etc/passwd)\n\n![remote](https://example.com/pixel.png) ![inline](data:image/png;base64,AAAA)'
  const result = html(source)
  assert.doesNotMatch(result, /<(script|img|iframe)\b|href="(?:javascript|data|file):/i)
  assert.match(result, /&lt;script&gt;/)
  assert.match(result, />remote<\/a>/)
  assert.match(result, /<span>inline<\/span>/)
})

test('safe links use external browser attributes and relative file labels stay inert', () => {
  const result = html('[Docs](https://example.com) [Email](mailto:dev@example.com) [source](src/index.ts) https://example.com/path')
  assert.match(result, /href="https:\/\/example.com\/" target="_blank" rel="noopener noreferrer"/)
  assert.match(result, /href="mailto:dev@example.com"/)
  assert.match(result, /<a>source<\/a>/)
  for (const value of ['javascript:alert(1)', 'file:///tmp/a', 'data:text/html,hi', 'vscode://file/x', '//example.com', 'src/a.ts', '\nhttps://example.com', 'https://example.com\u0000']) assert.equal(markdownExternalUrl(value), undefined, value)
  assert.equal(markdownExternalUrl('https://example.com/a'), 'https://example.com/a')
})

function component (t) {
  const originals = { requestAnimationFrame: global.requestAnimationFrame, cancelAnimationFrame: global.cancelAnimationFrame }
  const frames = new Map()
  let sequence = 0, renders = 0
  global.requestAnimationFrame = fn => { frames.set(++sequence, fn); return sequence }
  global.cancelAnimationFrame = id => frames.delete(id)
  const links = [], clipboard = []
  const host = { querySelectorAll: () => [], contains: () => true }
  const renderer = { setProperty: (node, key, value) => { node[key] = value }, setAttribute: (node, key, value) => { node[key] = value } }
  const platform = { openExternal: href => links.push(href), setClipboard: value => clipboard.push(value) }
  const instance = new MarkdownComponent({ nativeElement: host }, renderer, { detectChanges: () => renders++ }, platform)
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()) }
  t.after(() => { instance.ngOnDestroy(); setLanguage('en'); Object.assign(global, originals) })
  return { instance, flush, frames, host, platform, links, clipboard, renders: () => renders }
}

test('streaming coalesces input changes, preserves raw text and cancels work on destruction', t => {
  const s = component(t)
  for (const value of ['Hello', 'Hello **world', 'Hello **world**']) { s.instance.text = value; s.instance.ngOnChanges() }
  assert.equal(s.frames.size, 1)
  s.flush()
  assert.equal(s.renders(), 1)
  assert.match(s.instance.blocks[0].html, /<strong>world<\/strong>/)
  assert.equal(s.instance.text, 'Hello **world**')
  s.instance.text = 'Next'; s.instance.ngOnChanges()
  s.instance.ngOnDestroy()
  assert.equal(s.frames.size, 0)
  s.flush(); assert.equal(s.renders(), 1)
})

test('switching interface language updates accessible table labels without translating model text', t => {
  const s = component(t)
  setLanguage('en')
  s.instance.text = '| 测试 |\n| --- |\n| Ready |'; s.instance.ngOnChanges(); s.flush()
  assert.match(s.instance.blocks[0].html, /aria-label="Table"/)
  setLanguage('zh-CN'); s.flush()
  assert.match(s.instance.blocks[0].html, /aria-label="表格"/)
  assert.match(s.instance.blocks[0].html, /Ready/)
})

test('code copy preserves indentation and angle brackets, and reports clipboard failures', t => {
  const s = component(t)
  const code = { textContent: '  echo "<hello>"\n\n' }
  const button = { isConnected: true, closest: () => ({ querySelector: () => code }) }
  const event = { target: { closest: () => button }, preventDefault() {} }
  s.instance.onClick(event)
  assert.deepEqual(s.clipboard, [{ text: '  echo "<hello>"\n\n' }])
  assert.equal(button.textContent, 'Copied')
  s.platform.setClipboard = () => { throw Error('clipboard unavailable') }
  s.instance.onClick(event)
  assert.equal(button.textContent, 'Copy failed')
})

test('link activation prevents embedded navigation and opens only allowed destinations', t => {
  const s = component(t)
  for (const [href, button] of [['https://example.com/docs', 0], ['mailto:dev@example.com', 1], ['file:///tmp/private', 0], ['javascript:alert(1)', 0], ['https://example.com', 2]]) {
    let prevented = false
    s.instance.onLink({ target: { closest: () => ({ getAttribute: () => href }) }, button, preventDefault: () => { prevented = true } })
    assert.equal(prevented, true)
  }
  assert.deepEqual(s.links, ['https://example.com/docs', 'mailto:dev@example.com'])
})
