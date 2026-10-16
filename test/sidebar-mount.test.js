const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const ts = require('typescript')

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText
  module._compile(output, filename)
}
const { findSidebarMount } = require('../src/sidebar-mount.ts')

class Element {
  constructor (classes = [], children = []) { this.classes = classes; this.children = children }
  querySelector (selector) {
    assert.match(selector, /^:scope > \./)
    return this.children.find(child => child.classes.includes(selector.slice(10))) || null
  }
}

test('mounts beside the entire tab area when Tabby has no .window wrapper', () => {
  const main = new Element(['content'])
  const outer = new Element(['content'], [new Element(['tab-bar']), main])
  const app = new Element([], [outer])
  assert.deepEqual(findSidebarMount(app), { container: app, main: outer, wrap: true })
})

test('mounts beside the entire tab area when Tabby has a .window wrapper', () => {
  const main = new Element(['content'])
  const outer = new Element(['content'], [new Element(['tab-bar']), main])
  const windowRoot = new Element(['window'], [outer])
  const app = new Element([], [windowRoot])
  assert.deepEqual(findSidebarMount(app), { container: windowRoot, main: outer, wrap: true })
})

test('mounts beside the main content in the older window layout', () => {
  const main = new Element(['content', 'main'])
  const windowRoot = new Element(['window'], [main])
  const app = new Element([], [windowRoot])
  assert.deepEqual(findSidebarMount(app), { container: windowRoot, main, wrap: true })
  assert.equal(findSidebarMount(new Element()), null)
})
