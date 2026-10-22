const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
const original = require.extensions['.ts']
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
}).outputText, filename)
const { terminalKeySequence, matchesProcess, terminalInteractionState } = require('../src/terminal-keys.ts')
require.extensions['.ts'] = original

test('terminal keys encode Shift+Left, application cursor mode, Shift+Tab and Ctrl+C', () => {
  assert.equal(terminalKeySequence({ key: 'Left', shift: true }), '\x1b[1;2D')
  assert.equal(terminalKeySequence({ key: 'Left', shift: true }, true), '\x1b[1;2D')
  assert.equal(terminalKeySequence({ key: 'Up' }), '\x1b[A')
  assert.equal(terminalKeySequence({ key: 'Up' }, true), '\x1bOA')
  assert.equal(terminalKeySequence({ key: 'Down', ctrl: true, alt: true }), '\x1b[1;7B')
  assert.equal(terminalKeySequence({ key: 'Tab', shift: true }), '\x1b[Z')
  assert.equal(terminalKeySequence({ key: 'Enter' }), '\r')
  assert.equal(terminalKeySequence({ key: 'c', ctrl: true }), '\x03')
  assert.equal(terminalKeySequence({ key: 'PageDown', shift: true }), '\x1b[6;2~')
  assert.equal(terminalKeySequence({ key: 'Down', repeat: 2 }), '\x1b[B\x1b[B')
  for (const args of [{ key: 'Enter', shift: true }, { key: 'Left', shift: 'true' }, { key: 'Left', repeat: 0 }, { key: 'Left', repeat: 21 }, { key: 'Meta' }, { key: '\x1b[1;2D' }]) assert.throws(() => terminalKeySequence(args))
})

test('process identity matches executable tokens, quoted paths and launchers, not similar names', () => {
  for (const command of ['codex', '/usr/bin/codex --model test', 'node /path/bin/codex.js', '"C:\\Program Files\\Codex\\codex.exe" --help']) assert.equal(matchesProcess([command], 'codex'), true, command)
  for (const command of ['not-codex', 'codex-helper', '/usr/bin/codex.fake', 'other-agent']) assert.equal(matchesProcess([command], 'codex'), false, command)
  assert.throws(() => matchesProcess(['codex'], '.*'), /executable/)
})

test('readable terminal state retains cursor and inverse selected menu text', () => {
  const text = 'Choose: yes no'
  const line = {
    getCell: index => ({ isInverse: () => index >= 8 && index < 11, isBold: () => false, getBgColorMode: () => 0 }),
    translateToString: (_trim, start = 0, end = text.length) => text.slice(start, end),
  }
  const state = terminalInteractionState({ cols: text.length, modes: { applicationCursorKeysMode: true }, buffer: { active: { type: 'alternate', cursorX: 8, cursorY: 0, baseY: 0, length: 1, getLine: () => line } } }, 0)
  assert.equal(state.bufferType, 'alternate')
  assert.deepEqual(state.cursor, { column: 8, row: 0 })
  assert.equal(state.applicationCursorKeysMode, true)
  assert.equal(state.highlights[0].text, 'yes')
  assert.equal(state.highlights[0].inverse, true)
})
