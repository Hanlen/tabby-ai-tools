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

for (const tool of ['send_input', 'send_keys', 'attach_process', 'release_tab']) {
  for (const interruption of ['timeout', 'abort', 'disconnect']) test(`${tool} has an unknown outcome after dispatch and ${interruption}; it is never replayed`, async () => {
    const sent = [], rpc = new UtilityRequests(message => sent.push(message), () => {})
    const controller = new AbortController()
    const pending = rpc.invoke('writer', 1, tool, { tabId: 'target' }, controller.signal, 10)
    const rejected = assert.rejects(pending, { code: 'unknown_outcome' })
    if (interruption === 'abort') controller.abort()
    if (interruption === 'disconnect') rpc.close()
    await rejected
    assert.equal(rpc.size, 0)
    assert.equal(sent.filter(message => message.type === 'tool').length, 1)
    if (interruption !== 'disconnect') assert.equal(sent.at(-1).type, 'cancel')
    rpc.receive({ id: sent[0].id, value: { sent: true } })
    assert.equal(rpc.size, 0, 'late success must not revive a write or trigger another dispatch')
    rpc.close()
  })
}
test('a write cancelled before dispatch sends nothing and authoritative denials remain distinguishable', async () => {
  const sent = [], rpc = new UtilityRequests(message => sent.push(message), () => {})
  const controller = new AbortController(); controller.abort()
  await assert.rejects(rpc.invoke('writer', 1, 'send_input', {}, controller.signal), { code: 'cancelled' })
  assert.equal(sent.length, 0)
  for (const code of ['approval_denied', 'approval_timeout', 'permission_denied', 'busy']) {
    const pending = rpc.invoke('writer', 1, 'send_input', {}, new AbortController().signal)
    const rejected = assert.rejects(pending, { code })
    rpc.receive({ id: sent.at(-1).id, error: code }); await rejected
  }
  rpc.close()
  await assert.rejects(rpc.invoke('writer', 1, 'send_input', {}, new AbortController().signal), { code: 'cancelled' })
  assert.equal(sent.length, 4)
})
