const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const ts = require('typescript')

require.extensions['.ts'] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  }).outputText, filename)
}
const { isolateSidebarKeyboard } = require('../src/sidebar-keyboard.ts')

class Element {
  constructor (parent, focusable = false) {
    this.parent = parent
    this.focusable = focusable
    this.ownerDocument = parent?.ownerDocument || { activeElement: null }
    this.listeners = new Map()
  }
  addEventListener (name, callback) {
    const listeners = this.listeners.get(name) || new Set()
    listeners.add(callback)
    this.listeners.set(name, listeners)
  }
  removeEventListener (name, callback) { this.listeners.get(name)?.delete(callback) }
  contains (element) { return element === this || !!element.parent && this.contains(element.parent) }
  closest () { return this.focusable || this.tabIndex !== undefined ? this : this.parent?.closest() }
  focus () { this.ownerDocument.activeElement = this }
  dispatch (type, properties = {}) {
    const event = Object.assign(new Event(type, { bubbles: true, cancelable: true }), properties)
    Object.defineProperty(event, 'target', { value: this })
    for (let node = this; node; node = node.parent) {
      for (const listener of node.listeners.get(type) || []) listener(event)
      if (event.cancelBubble) break
    }
    return event
  }
}

function setup () {
  const document = new Element()
  const terminal = new Element(document, true)
  const sidebar = new Element(document)
  const text = new Element(sidebar)
  const input = new Element(sidebar, true)
  const terminalKeys = []
  for (const type of ['keydown', 'keypress', 'keyup']) {
    document.addEventListener(type, event => terminalKeys.push([type, event.key]))
  }
  const destroy = isolateSidebarKeyboard(sidebar)
  return { document, terminal, sidebar, text, input, terminalKeys, destroy }
}

test('sidebar copy and paste preserve native defaults without triggering terminal hotkeys', () => {
  const s = setup()
  const localKeys = []
  s.input.addEventListener('keydown', event => localKeys.push(event.key))
  for (const key of ['Control', 'c', 'v', 'Meta', 'c', 'Enter', 'ArrowUp', 'Tab']) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      const event = s.input.dispatch(type, { key, ctrlKey: true })
      assert.equal(event.defaultPrevented, false, 'native clipboard and keyboard navigation remain available')
    }
  }
  assert.deepEqual(localKeys, ['Control', 'c', 'v', 'Meta', 'c', 'Enter', 'ArrowUp', 'Tab'])
  assert.deepEqual(s.terminalKeys, [])
  s.terminal.dispatch('keydown', { key: 'c', ctrlKey: true })
  assert.deepEqual(s.terminalKeys, [['keydown', 'c']], 'terminal shortcuts still work outside the sidebar')
})

test('selecting static sidebar text moves focus out of xterm without cancelling selection', () => {
  const s = setup()
  s.terminal.focus()
  assert.equal(s.text.dispatch('pointerdown', { button: 0 }).defaultPrevented, false)
  assert.equal(s.document.ownerDocument.activeElement, s.sidebar)
  s.document.ownerDocument.activeElement.dispatch('keydown', { key: 'c', ctrlKey: true })
  assert.deepEqual(s.terminalKeys, [])
})

test('sidebar focus respects native inputs, nested focusable controls and non-primary clicks', () => {
  const s = setup()
  s.terminal.focus()
  assert.equal(s.input.dispatch('pointerdown', { button: 0 }).defaultPrevented, false)
  assert.equal(s.document.ownerDocument.activeElement, s.terminal, 'do not preempt native pointer focus with focus()')
  // The browser focuses the input after dispatching pointerdown.
  s.input.focus()
  assert.equal(s.document.ownerDocument.activeElement, s.input)
  new Element(s.input).dispatch('pointerdown', { button: 0 })
  assert.equal(s.document.ownerDocument.activeElement, s.input)
  s.text.dispatch('pointerdown', { button: 2 })
  assert.equal(s.document.ownerDocument.activeElement, s.input)
})

test('clicking buttons and tabindex containers does not inherit programmatic keyboard focus', () => {
  const s = setup()
  for (const control of [new Element(s.sidebar, true), new Element(s.sidebar)]) {
    control.tabIndex = 0
    s.input.focus()
    const label = new Element(control)
    assert.equal(label.dispatch('pointerdown', { button: 0 }).defaultPrevented, false)
    assert.equal(s.document.ownerDocument.activeElement, s.input, 'leave focus to the native pointer default action')
    control.focus()
    control.dispatch('keydown', { key: 'Enter' })
    assert.deepEqual(s.terminalKeys, [])
  }
})

test('destroy releases event listeners when the sidebar is removed or remounted', () => {
  const s = setup()
  s.destroy()
  s.destroy()
  s.terminal.focus()
  s.text.dispatch('pointerdown', { button: 0 })
  assert.equal(s.document.ownerDocument.activeElement, s.terminal)
  s.input.dispatch('keydown', { key: 'c', ctrlKey: true })
  assert.deepEqual(s.terminalKeys, [['keydown', 'c']])
})
