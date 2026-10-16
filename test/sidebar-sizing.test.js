const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const ts = require('typescript')

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText
  module._compile(output, filename)
}
const { clampSidebarWidth } = require('../src/sidebar-sizing.ts')

test('sidebar drag stays usable while preserving terminal space', () => {
  assert.equal(clampSidebarWidth(440, 1200), 440)
  assert.equal(clampSidebarWidth(80, 1200), 220)
  assert.equal(clampSidebarWidth(1200, 1200), 900)
  assert.equal(clampSidebarWidth(700, 700), 460)
})
