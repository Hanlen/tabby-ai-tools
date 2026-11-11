const test = require('node:test')
const assert = require('node:assert/strict')
const { UtilityRequests } = require('../artifacts/mcp-utility-rpc.cjs')

test('a throwing parent send rejects and cleans every pending observation without leaking cancellation errors', async () => {
  const sent = []; let broken = false, disconnected = 0
  const rpc = new UtilityRequests(message => { if (broken) throw new Error('Parent gone'); sent.push(message) }, () => { disconnected++ })
  const first = rpc.invoke('a', 1, 'read_tab', {}, new AbortController().signal)
  const firstRejected = assert.rejects(first, { code: 'cancelled' })
  broken = true
  await assert.rejects(rpc.invoke('b', 1, 'read_tab', {}, new AbortController().signal), { code: 'cancelled' })
  await firstRejected
  assert.equal(rpc.size, 0); assert.equal(disconnected, 1)
  assert.equal(rpc.post({ type: 'activity' }), false); assert.equal(disconnected, 1)
  rpc.receive({ id: sent[0].id, value: 'late secret' }); assert.equal(rpc.size, 0)
})
test('aborting when the parent channel fails settles before notification and never replays a tool', async () => {
  const sent = []; let broken = false
  const rpc = new UtilityRequests(message => { if (broken) throw new Error('Parent gone'); sent.push(message) }, () => {})
  const signal = new AbortController()
  const pending = rpc.invoke('a', 1, 'read_tab', {}, signal.signal)
  const rejected = assert.rejects(pending, { code: 'cancelled' })
  broken = true; signal.abort(); await rejected
  assert.equal(rpc.size, 0); assert.equal(sent.filter(m => m.type === 'tool').length, 1)
})
test('bounded observer timeout is distinguished from channel closure and stale replies are ignored', async () => {
  const sent = [], rpc = new UtilityRequests(message => sent.push(message), () => {})
  await assert.rejects(rpc.invoke('a', 1, 'read_tab', {}, new AbortController().signal, 10), { code: 'observation_timeout' })
  assert.equal(rpc.size, 0); assert.equal(sent.at(-1).type, 'cancel')
  rpc.receive({ id: sent[0].id, value: 'late' })
  const current = rpc.invoke('a', 1, 'read_tab', {}, new AbortController().signal)
  rpc.receive({ id: sent.at(-1).id, value: { text: 'current' } })
  assert.deepEqual(await current, { text: 'current' }); rpc.close()
})
