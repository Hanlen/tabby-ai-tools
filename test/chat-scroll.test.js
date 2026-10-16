const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const ts = require('typescript')

require.extensions['.ts'] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  }).outputText, filename)
}
const { ChatScroll } = require('../src/chat-scroll.ts')

function setup (t, height = 1000) {
  const frames = new Map()
  const observers = []
  let nextFrame = 0
  class Observer {
    constructor (callback) { this.callback = callback; this.connected = true; observers.push(this) }
    observe () {}
    disconnect () { this.connected = false }
  }
  const originals = Object.fromEntries(['ResizeObserver', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame'].map(key => [key, global[key]]))
  global.ResizeObserver = Observer
  global.MutationObserver = Observer
  global.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame }
  global.cancelAnimationFrame = id => frames.delete(id)
  const feed = new EventTarget()
  feed.closest = () => null
  feed.scrollHeight = height
  feed.clientHeight = 200
  let top = 0
  Object.defineProperty(feed, 'scrollTop', {
    get: () => top,
    set: value => { top = Math.max(0, Math.min(value, feed.scrollHeight - feed.clientHeight)) },
  })
  const visibility = []
  const scroll = new ChatScroll(feed, {}, value => visibility.push(value))
  t.after(() => { scroll.destroy(); Object.assign(global, originals) })
  const flush = () => {
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach(callback => callback())
  }
  const change = () => observers.forEach(observer => { if (observer.connected) observer.callback() })
  const event = (type, data = {}) => feed.dispatchEvent(Object.assign(new Event(type), data))
  const move = top => { feed.scrollTop = top; event('scroll') }
  return { feed, scroll, flush, change, event, move, visibility, observers, frames }
}

test('initial history, new messages and streaming growth stay at the bottom', t => {
  const s = setup(t)
  s.flush()
  assert.equal(s.feed.scrollTop, 800)
  for (const height of [1200, 1700, 3000]) {
    s.feed.scrollHeight = height
    s.change()
    s.flush()
    assert.equal(s.feed.scrollTop, height - 200)
  }
  assert.deepEqual(s.visibility, [])
})

test('scrolling back pauses output, and clicking latest restores following', t => {
  const s = setup(t)
  s.flush()
  s.move(400)
  s.feed.scrollHeight = 1800
  s.change()
  s.flush()
  assert.equal(s.feed.scrollTop, 400)
  assert.deepEqual(s.visibility, [true])
  s.scroll.jumpToLatest()
  s.flush()
  assert.equal(s.feed.scrollTop, 1600)
  assert.deepEqual(s.visibility, [true, false])
  s.feed.scrollHeight = 2000
  s.change()
  s.flush()
  assert.equal(s.feed.scrollTop, 1800)
})

test('manual scrolling to the bottom resumes following', t => {
  const s = setup(t)
  s.flush()
  s.move(200)
  s.move(800)
  s.feed.scrollHeight = 1300
  s.change()
  s.flush()
  assert.equal(s.feed.scrollTop, 1100)
  assert.deepEqual(s.visibility, [true, false])
})

test('an upward wheel gesture cancels a queued follow even during content growth', t => {
  const s = setup(t)
  s.flush()
  s.feed.scrollHeight = 1600
  s.change()
  s.event('wheel', { deltaY: -100 })
  s.move(700)
  s.flush()
  assert.equal(s.feed.scrollTop, 700)
  assert.deepEqual(s.visibility, [true])
})

test('dragging the scrollbar back during streaming cancels a queued follow', t => {
  const s = setup(t)
  s.flush()
  s.feed.scrollHeight = 1600
  s.change()
  s.move(700)
  s.flush()
  assert.equal(s.feed.scrollTop, 700)
  assert.deepEqual(s.visibility, [true])
})

test('touch and keyboard scrolling pause following before the browser moves', t => {
  const s = setup(t)
  s.flush()
  s.event('touchstart', { touches: [{ clientY: 100 }] })
  s.event('touchmove', { touches: [{ clientY: 160 }] })
  s.feed.scrollHeight += 500
  s.change()
  s.flush()
  assert.equal(s.feed.scrollTop, 800)
  s.scroll.jumpToLatest()
  s.flush()
  s.event('keydown', { key: 'PageUp' })
  s.feed.scrollHeight += 500
  s.change()
  s.flush()
  assert.equal(s.feed.scrollTop, 1300)
})

test('viewport changes follow while attached and preserve position while reading history', t => {
  const s = setup(t)
  s.flush()
  s.feed.clientHeight = 100
  s.change()
  s.flush()
  assert.equal(s.feed.scrollTop, 900)
  s.move(300)
  s.feed.clientHeight = 150
  s.change()
  s.flush()
  assert.equal(s.feed.scrollTop, 300)
})

test('short conversations and layout clamping do not interrupt following', t => {
  const s = setup(t, 100)
  s.event('wheel', { deltaY: -100 })
  s.flush()
  s.feed.scrollHeight = 1000
  s.change()
  s.flush()
  s.feed.clientHeight = 400
  s.move(600)
  s.feed.scrollHeight = 1200
  s.change()
  s.flush()
  assert.equal(s.feed.scrollTop, 800)
  assert.deepEqual(s.visibility, [])
})

test('destroy disconnects observers, listeners and pending animation frames', t => {
  const s = setup(t)
  s.scroll.destroy()
  assert.equal(s.frames.size, 0)
  assert.ok(s.observers.every(observer => !observer.connected))
  s.move(400)
  assert.deepEqual(s.visibility, [])
})
