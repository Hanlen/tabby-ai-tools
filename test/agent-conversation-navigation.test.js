const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const ts = require('typescript')
const Module = require('node:module')
const state = new Module('agent-conversation-state')
state._compile(ts.transpileModule(fs.readFileSync('src/agent-conversation-state.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, 'agent-conversation-state.js')
const { conversationOutcome, outcomeLabel } = state.exports

test('outcomes distinguish completion, ordinary interruptions, stops, limits and external blockers', () => {
  assert.equal(conversationOutcome('completed'), 'complete')
  assert.equal(conversationOutcome('completed', { awaitingGoal: true }), 'running')
  assert.equal(conversationOutcome('completed', { goalStatus: 'active' }), 'incomplete')
  assert.equal(conversationOutcome('completed', { goalStatus: 'blocked' }), 'blocked')
  assert.equal(conversationOutcome('interrupted'), 'interrupted')
  assert.equal(conversationOutcome('interrupted', { stopRequested: true }), 'stopped')
  assert.equal(conversationOutcome('inProgress', { stopRequested: true }), 'running')
  assert.equal(conversationOutcome('completed', { stopRequested: true }), 'complete')
  assert.equal(conversationOutcome('failed'), 'unknown')
  assert.equal(conversationOutcome('failed', { terminationReason: 'execution_limit' }), 'limited')
  assert.equal(conversationOutcome('failed', { terminationReason: 'unfinished' }), 'incomplete')
  assert.equal(conversationOutcome('failed', { terminationReason: 'external' }), 'blocked')
  assert.equal(conversationOutcome('failed', { error: { codexErrorInfo: 'sessionBudgetExceeded' } }), 'limited')
  assert.equal(conversationOutcome('completed', { goalStatus: 'budgetLimited' }), 'limited')
  assert.equal(conversationOutcome('unexpected'), 'unknown')
  assert.notEqual(outcomeLabel('stopped'), outcomeLabel('interrupted'))
})

const navigation = new Module('agent-conversation-navigation')
navigation.require = request => {
  if (request === '@angular/core') return {
    Component: () => target => target, Input: () => () => {}, Output: () => () => {},
    EventEmitter: class { emit (entry) { this.callback?.(entry) } },
  }
  if (request === './i18n') return { translate: value => value }
  if (request === './agent-conversation-state') return state.exports
  throw new Error('Unexpected fixture import: ' + request)
}
navigation._compile(ts.transpileModule(fs.readFileSync('src/agent-conversation-navigation.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, experimentalDecorators: true },
}).outputText, 'agent-conversation-navigation.js')
const { AgentConversationNavigationComponent } = navigation.exports

function selectionFixture (t, offsets) {
  const original = global.requestAnimationFrame
  const frames = []
  global.requestAnimationFrame = callback => { frames.push(callback); return frames.length }
  t.after(() => { global.requestAnimationFrame = original })
  const feed = {
    scrollTop: 0, getBoundingClientRect: () => ({ top: 100 }),
    querySelectorAll: () => offsets.map((offset, i) => ({
      getBoundingClientRect: () => ({ top: 100 + offset - feed.scrollTop }),
      getAttribute: () => 'q' + i,
    })),
  }
  const component = new AgentConversationNavigationComponent({
    nativeElement: { querySelector: () => null, querySelectorAll: () => [] },
  })
  component.feed = feed
  component.entries = offsets.map((_, i) => ({ id: 'q' + i, kind: 'user', text: 'Question ' + i }))
  const update = () => { component.update(); frames.splice(0).forEach(callback => callback()) }
  return { component, feed, update }
}

test('clicked question stays current when short content cannot scroll', t => {
  const { component, update } = selectionFixture(t, [12, 60, 110])
  update()
  assert.equal(component.current, 'q0')
  component.activate(component.entries[2], 2)
  update()
  update() // Mutations/layout callbacks must not erase a stationary selection.
  assert.equal(component.current, 'q2')
  assert.equal(component.selection, 2)
})

test('clamped bottom selection survives queued scroll events then yields to manual scrolling', t => {
  const { component, feed, update } = selectionFixture(t, [12, 120, 240, 360])
  component.navigate.callback = () => { feed.scrollTop = 180 } // Cannot align q3 to top.
  component.activate(component.entries[3], 3)
  update()
  assert.equal(component.current, 'q3')
  feed.scrollTop = 100
  update()
  assert.equal(component.current, 'q0')
  feed.scrollTop = 230
  update()
  assert.equal(component.current, 'q2')
})

test('clicks at the same scroll position and removal of selected question stay consistent', t => {
  const { component, update } = selectionFixture(t, [12, 60, 110])
  for (const index of [2, 1, 0, 2]) {
    component.activate(component.entries[index], index)
    update()
    assert.equal(component.current, 'q' + index)
  }
  component.entries = component.entries.slice(0, 2)
  update()
  assert.equal(component.current, 'q0')
})

test('viewport tracking tolerates fractional pixel positioning after navigation', t => {
  const { component, feed, update } = selectionFixture(t, [12, 112.3])
  feed.scrollTop = 100
  update()
  assert.equal(component.current, 'q1')
})

test('shared scrollbar thumb tracks feed size and position', t => {
  const { component, feed } = selectionFixture(t, [12])
  component.host.nativeElement.clientHeight = 200
  feed.scrollHeight = 1000
  feed.clientHeight = 200
  feed.scrollTop = 400
  component.measureScrollbar()
  assert.equal(component.scrollable, true)
  assert.equal(component.thumbHeight, 40)
  assert.equal(component.thumbTop, 80)
  assert.equal(component.scrollPercent, 50)
  feed.scrollHeight = 150
  feed.scrollTop = 0
  component.measureScrollbar()
  assert.equal(component.scrollable, false)
  assert.equal(component.thumbHeight, 200)
  assert.equal(component.thumbTop, 0)
})

test('shared scrollbar drag preserves grab offset and releases capture on cancellation', t => {
  const { component, feed } = selectionFixture(t, [12])
  component.host.nativeElement.clientHeight = 200
  Object.assign(feed, { scrollHeight: 1000, clientHeight: 200, scrollTop: 400 })
  component.measureScrollbar()
  const captures = new Set()
  const track = { clientHeight: 200, getBoundingClientRect: () => ({ top: 100 }),
    setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id),
    releasePointerCapture: id => captures.delete(id) }
  const event = { currentTarget: track, clientY: 190, pointerId: 1, isPrimary: true, button: 0, preventDefault () {} }
  component.startDrag(event)
  assert.equal(feed.scrollTop, 400)
  component.drag({ ...event, clientY: 110 })
  assert.equal(feed.scrollTop, 0)
  component.drag({ ...event, clientY: 270 })
  assert.equal(feed.scrollTop, 800)
  component.endDrag(event)
  assert.equal(captures.size, 0)
  component.drag({ ...event, clientY: 110 })
  assert.equal(feed.scrollTop, 800, 'pointer movement after cancellation does nothing')
})

test('scrollbar keyboard scrolling ignores modified shortcuts', t => {
  const { component, feed } = selectionFixture(t, [12])
  Object.assign(feed, { scrollHeight: 1000, clientHeight: 200, scrollTop: 400 })
  component.host.nativeElement.clientHeight = 200
  let prevented = false
  component.scrollKey({ key: 'PageUp', preventDefault () { prevented = true } })
  assert.equal(feed.scrollTop, 200)
  assert.equal(prevented, true)
  component.scrollKey({ key: 'Home', ctrlKey: true, preventDefault () { throw new Error('modified shortcut intercepted') } })
  assert.equal(feed.scrollTop, 200)
})
