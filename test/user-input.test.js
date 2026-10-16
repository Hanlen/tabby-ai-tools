const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const Module = require('node:module')
const ts = require('typescript')

const originalLoad = Module._load
const originalTsLoader = require.extensions['.ts']
Module._load = function (request, parent, isMain) {
  if (request === '@angular/core') return { Component: () => target => target, Input: () => () => {}, Output: () => () => {}, ViewChild: () => () => {}, EventEmitter: class {} }
  if (request === 'tabby-core') return { ConfigService: class {} }
  if (request === 'tabby-terminal') return { BaseTerminalTabComponent: class {} }
  if (request === './codex.service' || request === './terminal-output.service' || request === './tab-tools') return {}
  if (request.endsWith('.pug') || request.endsWith('.css')) return ''
  return originalLoad.call(this, request, parent, isMain)
}
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, experimentalDecorators: true } }).outputText
  module._compile(output, filename)
}
const { CodexPanelComponent } = require('../src/codex-panel.component.ts')
const { answersComplete, formatAnswers, isUserInputMethod } = require('../src/user-input.ts')
Module._load = originalLoad
require.extensions['.ts'] = originalTsLoader
const fakeTabTools = { releaseOwner: () => {}, getControl: () => undefined, controls$: { value: [] } }

test('top model summary resolves defaults and keeps the running model until the next turn', () => {
  const settings = { model: '', reasoningEffort: '' }
  const panel = new CodexPanelComponent({ store: { codexAgent: settings } }, {
    client: {}, getThreadConfiguration: id => id === 'current' ? { model: 'resolved', reasoningEffort: 'high' } : undefined,
  }, { run: callback => callback() }, {}, fakeTabTools)
  panel.threadId = 'current'
  assert.equal(panel.currentModel, 'resolved')
  assert.equal(panel.currentReasoningEffort, 'high')
  panel.busy = true
  settings.model = 'next'
  settings.reasoningEffort = 'ultra'
  assert.equal(panel.currentModel, 'resolved')
  assert.equal(panel.currentReasoningEffort, 'high')
  panel.busy = false
  assert.equal(panel.currentModel, 'next')
  assert.equal(panel.currentReasoningEffort, 'ultra')
  panel.threadId = 'other'
  settings.model = settings.reasoningEffort = ''
  assert.equal(panel.currentModel, 'Codex 默认')
  assert.equal(panel.currentReasoningEffort, '默认')
})

test('a rejected send shows quota guidance, restores the prompt and permits retry', async () => {
  let reject = true
  const panel = new CodexPanelComponent({ store: { codexAgent: {} } }, {
    client: {}, setGoal: async () => {}, startTurn: async () => {
      if (reject) throw new Error('You have hit your usage limit. Try again later.')
      return 'retry-turn'
    },
  }, { run: callback => callback() }, {}, fakeTabTools)
  panel.loading = false
  panel.threadId = 'current'
  panel.ensureSource = async () => {}
  panel.readOutput = () => ({ cursor: 0, length: 0, message: '' })
  panel.scheduleOutputFlush = () => {}
  panel.prompt = 'My question'
  await panel.send()
  assert.match(panel.sendNotice, /上限.*恢复/)
  assert.match(panel.sendNotice, /usage limit/)
  assert.equal(panel.prompt, 'My question')
  assert.equal(panel.busy, false)
  assert.equal(panel.turnId, '')
  assert.equal(panel.entries.at(-1).kind, 'system')
  assert.equal(panel.entries.at(-1).text, panel.sendNotice)
  reject = false
  await panel.send()
  assert.equal(panel.sendNotice, '')
  assert.equal(panel.prompt, '')
  assert.equal(panel.turnId, 'retry-turn')
})

test('asynchronous quota failures show reset information, release control and avoid duplicate messages', () => {
  const released = []
  const panel = new CodexPanelComponent({ store: { codexAgent: {} } }, { client: {} }, { run: callback => callback() }, {}, {
    ...fakeTabTools, releaseOwner: owner => released.push(owner),
  })
  panel.threadId = 'current'
  panel.turnId = 'turn-1'
  panel.busy = true
  panel.handleEvent({ method: 'account/rateLimits/updated', params: { rateLimits: {
    limitId: 'codex', primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 2000000000 },
  } } })
  // Sparse updates retain the previously reported reset time.
  panel.handleEvent({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex', primary: null } } })
  const error = { message: 'Request denied', codexErrorInfo: 'usageLimitExceeded' }
  panel.handleEvent({ method: 'error', params: { threadId: 'other', error, willRetry: false } })
  assert.equal(panel.sendNotice, '')
  panel.handleEvent({ method: 'error', params: { threadId: 'current', turnId: 'turn-1', error, willRetry: false } })
  assert.match(panel.sendNotice, /上限/)
  assert.match(panel.sendNotice, /重置/)
  assert.equal(panel.busy, false)
  assert.equal(panel.turnId, '')
  assert.deepEqual(released, ['current'])
  panel.handleEvent({ method: 'turn/completed', params: { threadId: 'current', turn: { id: 'turn-1', status: 'failed', error } } })
  assert.equal(panel.entries.length, 1)
  assert.match(panel.entries[0].text, /Request denied/)
})

test('retryable errors keep the turn active and clear the notice when an answer arrives', () => {
  const panel = new CodexPanelComponent({ store: { codexAgent: {} } }, { client: {} }, { run: callback => callback() }, {}, fakeTabTools)
  panel.threadId = 'current'
  panel.turnId = 'turn-1'
  panel.busy = true
  panel.handleEvent({ method: 'error', params: { threadId: 'current', turnId: 'turn-1', error: { message: '429 rate limit exceeded' }, willRetry: true } })
  assert.match(panel.sendNotice, /自动重试/)
  assert.equal(panel.busy, true)
  assert.equal(panel.turnId, 'turn-1')
  panel.handleEvent({ method: 'item/agentMessage/delta', params: { threadId: 'current', itemId: 'answer', delta: 'Recovered' } })
  assert.equal(panel.sendNotice, '')
})

test('failed turns explain context and budget limits even without a separate error event', () => {
  const panel = new CodexPanelComponent({ store: { codexAgent: {} } }, { client: {} }, { run: callback => callback() }, {}, fakeTabTools)
  panel.threadId = 'current'
  for (const [info, expected] of [['contextWindowExceeded', /上下文.*\/new/], ['sessionBudgetExceeded', /预算上限/], ['other', /Specific backend failure/]]) {
    panel.handleEvent({ method: 'turn/completed', params: { threadId: 'current', turn: {
      id: info, status: 'failed', error: { message: 'Specific backend failure', codexErrorInfo: info },
    } } })
    assert.match(panel.sendNotice, expected)
  }
})

test('a rejected steer shows the failure without releasing the running turn', async () => {
  const panel = new CodexPanelComponent({ store: { codexAgent: {} } }, {
    client: {}, steer: async () => { throw new Error('This turn cannot accept input') },
  }, { run: callback => callback() }, {}, fakeTabTools)
  panel.loading = false
  panel.threadId = 'current'
  panel.turnId = 'running'
  panel.busy = true
  panel.ensureSource = async () => {}
  panel.prompt = 'Extra instruction'
  await panel.send()
  assert.match(panel.sendNotice, /cannot accept input/)
  assert.equal(panel.prompt, 'Extra instruction')
  assert.equal(panel.busy, true)
  assert.equal(panel.turnId, 'running')
})

test('shared server deltas stream into their own panels before turn completion', () => {
  const panel = id => {
    const instance = new CodexPanelComponent({ store: { codexAgent: {} } }, { client: {} }, { run: callback => callback() }, {}, fakeTabTools)
    instance.threadId = id
    instance.busy = true
    return instance
  }
  const first = panel('thread-1')
  const second = panel('thread-2')
  const broadcast = event => { first.handleEvent(event); second.handleEvent(event) }
  broadcast({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', itemId: 'message-1', delta: '你好' } })
  assert.equal(first.entries[0].text, '你好')
  assert.equal(first.busy, true)
  assert.deepEqual(second.entries, [])
  broadcast({ method: 'item/agentMessage/delta', params: { threadId: 'thread-2', itemId: 'message-2', delta: '另一个回复' } })
  broadcast({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', itemId: 'message-1', delta: '，正在处理' } })
  assert.equal(first.entries[0].text, '你好，正在处理')
  assert.equal(second.entries[0].text, '另一个回复')
  broadcast({ method: 'item/completed', params: { threadId: 'thread-1', item: { type: 'agentMessage', id: 'message-1', text: '你好，正在处理。' } } })
  assert.equal(first.entries.length, 1)
  assert.equal(first.entries[0].text, '你好，正在处理。')
})

test('disconnect clears pending approvals and questions before the server reconnects', () => {
  const panel = new CodexPanelComponent({ store: { codexAgent: {} } }, { client: {} }, { run: callback => callback() }, {}, fakeTabTools)
  panel.threadId = 'thread-1'
  panel.turnId = 'turn-1'
  panel.connected = true
  panel.busy = true
  panel.request = { id: 42, method: 'item/tool/requestUserInput' }
  panel.pendingQuestionReply = 'obsolete answer'
  panel.questionInterrupting = true
  panel.onDisconnect(new Error('process exited'))
  assert.equal(panel.request, undefined)
  assert.equal(panel.pendingQuestionReply, '')
  assert.equal(panel.questionInterrupting, false)
  assert.equal(panel.connected, false)
  assert.equal(panel.busy, false)
  assert.equal(panel.turnId, '')
})

test('user input protocol uses the app-server request name and preserves selected answers', () => {
  assert.equal(isUserInputMethod('item/tool/requestUserInput'), true)
  const questions = [{ id: 'choice', question: 'Pick one', options: [{ label: 'Yes' }, { label: 'No' }], isOther: true }]
  assert.equal(answersComplete(questions, {}, fakeTabTools), false)
  assert.equal(answersComplete(questions, { choice: '__other__' }, { choice: '  later  ' }), true)
  assert.deepEqual(formatAnswers(questions, { choice: '__other__' }, { choice: '  later  ' }), { choice: { answers: ['later'] } })
})

test('blocking request appears and is answered through the response channel', () => {
  const responses = []
  const client = { respond: (id, result) => responses.push({ id, result }) }
  const panel = new CodexPanelComponent({ store: { codexAgent: {} } }, { client }, { run: callback => callback() }, {}, fakeTabTools)
  panel.threadId = 'thread-1'
  panel.busy = true
  panel.handleEvent({ id: 42, method: 'item/tool/requestUserInput', params: {
    threadId: 'thread-1', turnId: 'turn-1', isBlocking: true,
    questions: [{ id: 'choice', header: 'Decision', question: 'Continue?', isOther: false, options: [{ label: 'Yes', description: 'Proceed' }, { label: 'No', description: 'Stop' }] }],
  } })
  assert.equal(panel.request.questions[0].header, 'Decision')
  assert.equal(panel.status, '等待你选择答案…')
  assert.equal(panel.canSubmitRequest(), false)
  panel.request.answers.choice = 'Yes'
  panel.decide('accept')
  assert.deepEqual(responses, [{ id: 42, result: { answers: { choice: { answers: ['Yes'] } } } }])
  assert.equal(panel.request, undefined)
})

test('nonblocking protocol questions still answer their server request', () => {
  const responses = []
  const client = { respond: (id, result) => responses.push({ id, result }) }
  const panel = new CodexPanelComponent({ store: { codexAgent: {} } }, { client }, { run: callback => callback() }, {}, fakeTabTools)
  panel.threadId = 'thread-1'
  panel.handleEvent({ id: 43, method: 'item/tool/requestUserInput', params: {
    threadId: 'thread-1', isBlocking: false,
    questions: [{ id: 'choice', question: 'Continue?', options: [{ label: 'Yes' }] }],
  } })
  panel.request.answers.choice = 'Yes'
  panel.decide('accept')
  assert.deepEqual(responses, [{ id: 43, result: { answers: { choice: { answers: ['Yes'] } } } }])
})

test('questions in a streamed answer pause the turn and continue after the user chooses', () => {
  const interrupted = []
  const sent = []
  const client = { respond: () => {} }
  const panel = new CodexPanelComponent({ store: { codexAgent: {} } }, {
    client, interrupt: async (threadId, turnId) => { interrupted.push([threadId, turnId]) },
  }, { run: callback => callback() }, {}, fakeTabTools)
  panel.threadId = 'thread-1'
  panel.turnId = 'turn-1'
  panel.busy = true
  panel.send = async () => { sent.push(panel.prompt) }
  panel.handleEvent({ method: 'item/completed', params: {
    threadId: 'thread-1', item: { id: 'message-1', type: 'agentMessage', text: 'Choose a mode', questions: [{ title: 'Which mode?', options: ['Safe', 'Fast'] }] },
  } })
  assert.equal(panel.request.local, true)
  assert.deepEqual(interrupted, [['thread-1', 'turn-1']])
  panel.request.answers['question-0'] = 'Safe'
  panel.decide('accept')
  panel.handleEvent({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'interrupted' } } })
  assert.match(sent[0], /Safe/)
})

test('connection stays pending until the thread and history are ready', async () => {
  let finishThread
  const waitingForThread = new Promise(resolve => { finishThread = resolve })
  const settings = { cwd: '/tmp/project', threads: {} }
  const client = { isConnected: false }
  const panel = new CodexPanelComponent({ store: { codexAgent: settings }, save: async () => {} }, {
    client,
    connect: async () => { client.isConnected = true },
    openThread: () => waitingForThread,
    getGoal: async () => null,
  }, { run: callback => callback() }, {}, fakeTabTools)
  panel.loadHistory = async () => {}
  panel.cwd = '/tmp/project'
  const reconnecting = panel.reconnect()
  assert.equal(panel.loading, true)
  assert.equal(panel.connected, false)
  assert.equal(panel.status, '正在连接 Codex…')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(panel.connected, false)
  assert.equal(panel.status, '正在恢复会话…')
  finishThread('thread-1')
  await reconnecting
  assert.equal(panel.loading, false)
  assert.equal(panel.connected, true)
  assert.equal(panel.threadId, 'thread-1')
})

test('unsupported turn history does not mark a usable session disconnected', async () => {
  const calls = []
  const settings = { cwd: '/tmp/project', threads: {} }
  const client = { isConnected: true, request: async (method, params) => {
    calls.push({ method, params })
    if (method === 'thread/read') return { thread: { historyMode: 'paginated' } }
    if (method === 'thread/turns/list') throw new Error('list_turns is not supported yet')
    throw new Error(`Unexpected ${method}`)
  } }
  const panel = new CodexPanelComponent({ store: { codexAgent: settings }, save: async () => {} }, {
    client, connect: async () => {}, openThread: async () => 'thread-1', getGoal: async () => null,
  }, { run: callback => callback() }, {}, fakeTabTools)
  panel.cwd = '/tmp/project'
  await panel.reconnect()
  assert.equal(panel.connected, true)
  assert.equal(panel.loading, false)
  assert.equal(panel.status, '就绪')
  assert.match(panel.historyNotice, /旧消息/)
  assert.equal(calls[0].params.includeTurns, false)
})

test('paginated history restores turns in chronological order', async () => {
  const pages = [
    { data: [{ id: 'turn-3', status: 'completed', items: [{ id: 'agent-3', type: 'agentMessage', text: 'Third' }] }, { id: 'turn-2', status: 'completed', items: [{ id: 'agent-2', type: 'agentMessage', text: 'Second' }] }], nextCursor: 'older' },
    { data: [{ id: 'turn-1', status: 'completed', items: [{ id: 'agent-1', type: 'agentMessage', text: 'First' }] }], nextCursor: null },
  ]
  const client = { request: async method => {
    if (method === 'thread/read') return { thread: { historyMode: 'paginated' } }
    if (method === 'thread/turns/list') return pages.shift()
    throw new Error(`Unexpected ${method}`)
  } }
  const panel = new CodexPanelComponent({ store: { codexAgent: {} } }, { client }, { run: callback => callback() }, {}, fakeTabTools)
  panel.threadId = 'thread-1'
  await panel.loadHistory()
  assert.deepEqual(panel.entries.map(entry => entry.text), ['First', 'Second', 'Third'])
  assert.equal(panel.historyNotice, '')
})

test('selecting a saved session restores it and remembers the choice', async () => {
  const calls = []
  const settings = { cwd: '/project', threads: { '/project': 'current' }, tabToolThreads: { '/project': 'current' } }
  const client = { isConnected: true, request: async (method, params) => {
    calls.push({ method, params })
    if (method === 'thread/read') return { thread: { turns: [{ id: 'turn-1', status: 'completed', items: [{ id: 'reply-1', type: 'agentMessage', text: 'Earlier reply' }] }] } }
    return {}
  } }
  const service = {
    client, connect: async () => {}, resumeThread: async id => id, getGoal: async () => ({ status: 'active' }),
  }
  const panel = new CodexPanelComponent({ store: { codexAgent: settings }, save: async () => {} }, service, { run: callback => callback() }, {}, fakeTabTools)
  panel.cwd = '/project'
  panel.threadId = 'current'
  panel.connected = true
  panel.loading = false
  panel.historyOpen = true
  panel.contextUsedTokens = 500
  panel.contextWindowTokens = 1000
  await panel.selectSession({ id: 'old-session', cwd: '/project', originator: 'tabby_codex_agent', updatedAt: 1 })
  assert.equal(panel.threadId, 'old-session')
  assert.equal(settings.threads['/project'], 'old-session')
  assert.equal(settings.tabToolThreads['/project'], 'old-session')
  assert.deepEqual(panel.entries.map(entry => entry.text), ['Earlier reply'])
  assert.equal(panel.goalStatus, 'active')
  assert.equal(panel.historyOpen, false)
  assert.equal(panel.connected, true)
  assert.equal(panel.contextUsedTokens, null)
  assert.equal(panel.contextWindowTokens, null)
  assert.ok(calls.some(call => call.method === 'thread/unsubscribe' && call.params.threadId === 'current'))
})

test('/resume opens and closes the history list, which can load more sessions', async () => {
  const pages = [
    { data: [{ id: 'first', cwd: '/project', originator: 'tabby_codex_agent', updatedAt: 2 }], nextCursor: 'more' },
    { data: [{ id: 'second', cwd: '/project', originator: 'tabby_codex_agent', updatedAt: 1 }], nextCursor: null },
  ]
  const requested = []
  const panel = new CodexPanelComponent({ store: { codexAgent: {} } }, {
    client: { isConnected: true }, listSessions: async (cwd, cursor) => { requested.push([cwd, cursor]); return pages.shift() },
  }, { run: callback => callback() }, {}, fakeTabTools)
  panel.cwd = '/project'
  panel.loading = false
  panel.prompt = '/resume'
  await panel.send()
  assert.equal(panel.historyOpen, true)
  assert.deepEqual(panel.sessions.map(session => session.id), ['first'])
  await panel.loadSessions()
  assert.deepEqual(panel.sessions.map(session => session.id), ['first', 'second'])
  assert.deepEqual(requested, [['/project', null], ['/project', 'more']])
  panel.prompt = '/resume'
  await panel.send()
  assert.equal(panel.historyOpen, false)
})

test('failed session selection preserves the current conversation', async () => {
  const settings = { cwd: '/project', threads: { '/project': 'current' }, tabToolThreads: { '/project': 'current' } }
  const client = { isConnected: true }
  const service = { client, connect: async () => {}, resumeThread: async () => { throw new Error('resume failed') } }
  const panel = new CodexPanelComponent({ store: { codexAgent: settings } }, service, { run: callback => callback() }, {}, fakeTabTools)
  panel.cwd = '/project'
  panel.threadId = 'current'
  panel.entries = [{ id: 'message-1', kind: 'agent', text: 'Current reply' }]
  panel.connected = true
  panel.loading = false
  panel.status = '就绪'
  await panel.selectSession({ id: 'old-session', cwd: '/project', originator: 'tabby_codex_agent', updatedAt: 1 })
  assert.equal(panel.threadId, 'current')
  assert.equal(settings.threads['/project'], 'current')
  assert.deepEqual(panel.entries.map(entry => entry.text), ['Current reply'])
  assert.equal(panel.connected, true)
  assert.equal(panel.status, '就绪')
  assert.match(panel.historyError, /resume failed/)
})

test('an interrupted historical turn does not block resume when the server reports idle', async () => {
  const panel = new CodexPanelComponent({ store: { codexAgent: {} } }, {
    client: { request: async () => ({ thread: {
      status: { type: 'idle' },
      turns: [{ id: 'stale-turn', status: 'inProgress', items: [] }],
    } }) },
  }, { run: callback => callback() }, {}, fakeTabTools)
  panel.threadId = 'thread-1'
  await panel.loadHistory()
  assert.equal(panel.busy, false)
  assert.equal(panel.turnId, '')
})

test('resume does not accept sessions created by another client', async () => {
  const panel = new CodexPanelComponent({ store: { codexAgent: {} } }, {
    client: {}, resumeThread: async () => { throw new Error('Should not resume another client') },
  }, { run: callback => callback() }, {}, fakeTabTools)
  panel.cwd = '/project'
  panel.loading = false
  await panel.selectSession({ id: 'other', cwd: '/project', originator: 'codex_cli_rs' })
  assert.match(panel.historyError, /Tabby AI Agent/)
})

test('resume supports arrow selection and Enter while empty prompt remains unsent', () => {
  const panel = new CodexPanelComponent({ store: { codexAgent: {} } }, { client: {} }, { run: callback => callback() }, {}, fakeTabTools)
  panel.loading = false
  panel.historyOpen = true
  panel.sessions = [{ id: 'first' }, { id: 'second' }]
  panel.entries = [{ kind: 'user', text: 'Previous prompt' }]
  const selected = []
  panel.selectSession = async session => { selected.push(session.id) }
  const event = key => ({ key, preventDefault: () => {}, isComposing: false })
  panel.onPromptKeydown(event('ArrowDown'))
  assert.equal(panel.sessionSelection, 1)
  panel.onPromptKeydown(event('Enter'))
  assert.deepEqual(selected, ['second'])
  panel.onPromptKeydown(event('ArrowUp'))
  assert.equal(panel.sessionSelection, 0)
  panel.onPromptKeydown(event('Escape'))
  assert.equal(panel.historyOpen, false)
  assert.equal(panel.prompt, '')
})

test('prompt arrows browse sent messages, stop at the oldest and restore the draft', async () => {
  const sent = []
  const panel = new CodexPanelComponent({ store: { codexAgent: {} } }, {
    client: {}, steer: async (thread, turn, text) => { sent.push(text) },
  }, { run: callback => callback() }, {}, fakeTabTools)
  panel.loading = false
  panel.threadId = 'thread-1'
  panel.turnId = 'turn-1'
  panel.busy = true
  panel.ensureSource = async () => {}
  panel.onPromptChanged('First prompt')
  await panel.send()
  panel.entries.push({ kind: 'agent', text: 'Reply' })
  panel.onPromptChanged('Second prompt')
  await panel.send()
  panel.onPromptChanged('Unsent draft')
  let prevented = 0
  const key = key => panel.onPromptKeydown({ key, preventDefault: () => { prevented++ } })
  key('ArrowUp')
  assert.equal(panel.prompt, 'Second prompt')
  key('ArrowUp')
  assert.equal(panel.prompt, 'First prompt')
  key('ArrowUp')
  assert.equal(panel.prompt, 'First prompt')
  key('ArrowDown')
  assert.equal(panel.prompt, 'Second prompt')
  key('ArrowDown')
  assert.equal(panel.prompt, 'Unsent draft')
  key('ArrowDown')
  assert.equal(prevented, 5)
  assert.deepEqual(sent, ['First prompt', 'Second prompt'])
  key('ArrowUp')
  panel.onPromptChanged('Edited recalled message')
  key('ArrowDown')
  assert.equal(panel.prompt, 'Edited recalled message')
  await panel.send()
  key('ArrowUp')
  assert.equal(panel.prompt, 'Edited recalled message')
  key('ArrowDown')
  assert.equal(panel.prompt, '')
})

test('prompt history preserves multiline cursor movement, selections and modified arrows', async () => {
  const panel = new CodexPanelComponent({ store: { codexAgent: {} } }, { client: {} }, { run: callback => callback() }, {}, fakeTabTools)
  panel.loading = false
  panel.entries = [{ kind: 'user', text: 'Older\nmessage' }]
  panel.onPromptChanged('Draft\nsecond line')
  let prevented = 0
  const input = { value: panel.prompt, selectionStart: 7, selectionEnd: 7, setSelectionRange (start, end) { this.selectionStart = start; this.selectionEnd = end } }
  const key = (key, extra = {}) => panel.onPromptKeydown({ key, target: input, preventDefault: () => { prevented++ }, ...extra })
  key('ArrowUp')
  assert.equal(prevented, 0)
  input.selectionStart = input.selectionEnd = 0
  for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey', 'isComposing']) key('ArrowUp', { [modifier]: true })
  input.selectionEnd = 2
  key('ArrowUp')
  assert.equal(prevented, 0)
  input.selectionEnd = 0
  key('ArrowUp')
  assert.equal(panel.prompt, 'Older\nmessage')
  input.value = panel.prompt
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(input.selectionStart, 0)
  key('ArrowDown')
  assert.equal(prevented, 1)
  input.selectionStart = input.selectionEnd = input.value.length
  key('ArrowDown')
  assert.equal(panel.prompt, 'Draft\nsecond line')
  input.value = panel.prompt
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(input.selectionStart, input.value.length)
  assert.equal(prevented, 2)
})

test('prompt history works after restoring a session and resets when the session changes', async () => {
  const panel = new CodexPanelComponent({ store: { codexAgent: {} } }, {
    client: { request: async () => ({ thread: { turns: [{ items: [
      { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Restored prompt' }] },
      { id: 'agent-1', type: 'agentMessage', text: 'Restored reply' },
    ] }] } }) },
  }, { run: callback => callback() }, {}, fakeTabTools)
  panel.loading = false
  panel.threadId = 'restored-session'
  await panel.loadHistory()
  const key = key => panel.onPromptKeydown({ key, preventDefault: () => {} })
  key('ArrowUp')
  assert.equal(panel.prompt, 'Restored prompt')
  panel.applyHistory({ entries: [{ kind: 'user', text: 'Another session' }], busy: false, turnId: '', notice: '' })
  key('ArrowUp')
  assert.equal(panel.prompt, 'Another session')
})

test('creating a new session leaves the previous goal available for later reuse', async () => {
  const calls = []
  const settings = { cwd: '/project', threads: { '/project': 'old-session' }, tabToolThreads: { '/project': 'old-session' } }
  const client = { request: async (method, params) => { calls.push({ method, params }); return {} } }
  const service = { client, connect: async () => {}, openThread: async () => 'new-session' }
  const panel = new CodexPanelComponent({ store: { codexAgent: settings }, save: async () => {} }, service, { run: callback => callback() }, {}, fakeTabTools)
  panel.cwd = '/project'
  panel.threadId = 'old-session'
  panel.goalStatus = 'active'
  await panel.newConversation()
  assert.equal(panel.threadId, 'new-session')
  assert.equal(settings.threads['/project'], 'new-session')
  assert.equal(calls.some(call => call.method === 'thread/goal/clear'), false)
})

test('a failed new session keeps the current conversation visible', async () => {
  const settings = { cwd: '/project', threads: { '/project': 'old-session' }, tabToolThreads: { '/project': 'old-session' } }
  const client = { isConnected: true }
  const panel = new CodexPanelComponent({ store: { codexAgent: settings } }, {
    client, connect: async () => {}, openThread: async () => { throw new Error('start failed') },
  }, { run: callback => callback() }, {}, fakeTabTools)
  panel.cwd = '/project'
  panel.threadId = 'old-session'
  panel.entries = [{ id: 'old-reply', kind: 'agent', text: 'Keep me' }]
  panel.connected = true
  await panel.newConversation()
  assert.equal(panel.threadId, 'old-session')
  assert.equal(settings.threads['/project'], 'old-session')
  assert.deepEqual(panel.entries.map(entry => entry.text), ['Keep me'])
  assert.equal(panel.connected, true)
})

test('/new waits until a starting turn has an id before replacing the session', async () => {
  const panel = new CodexPanelComponent({ store: { codexAgent: {} } }, { client: {} }, { run: callback => callback() }, {}, fakeTabTools)
  panel.loading = false
  panel.busy = true
  panel.threadId = 'current'
  panel.prompt = '/new'
  await panel.send()
  assert.equal(panel.threadId, 'current')
  assert.equal(panel.prompt, '/new')
  assert.match(panel.status, /稍后/)
})

test('permission buttons persist the policies used by the next turn', async () => {
  let saved = 0
  const settings = { sandbox: 'workspace-write', approvalPolicy: 'on-request' }
  const panel = new CodexPanelComponent({ store: { codexAgent: settings }, save: async () => { saved++ } }, { client: {} }, { run: callback => callback() }, {}, fakeTabTools)
  panel.status = '任务已完成'
  await panel.setSandbox('danger-full-access')
  await panel.setApprovalPolicy('never')
  assert.equal(settings.sandbox, 'danger-full-access')
  assert.equal(settings.approvalPolicy, 'never')
  assert.equal(saved, 2)
  assert.equal(panel.permissionNotice, '')
  assert.equal(panel.status, '任务已完成')
})

test('failed permission save restores the previous choice', async () => {
  const settings = { sandbox: 'workspace-write', approvalPolicy: 'on-request' }
  const panel = new CodexPanelComponent({ store: { codexAgent: settings }, save: async () => { throw new Error('disk full') } }, { client: {} }, { run: callback => callback() }, {}, fakeTabTools)
  await panel.setSandbox('danger-full-access')
  assert.equal(settings.sandbox, 'workspace-write')
  assert.match(panel.permissionNotice, /disk full/)
})

test('/model opens the picker and saves the selected model without sending a turn', async () => {
  let saved = 0
  const models = [{ model: 'model-a', displayName: 'Model A' }]
  const settings = { model: '', sandbox: 'workspace-write', approvalPolicy: 'on-request' }
  const panel = new CodexPanelComponent({ store: { codexAgent: settings }, save: async () => { saved++ } }, {
    client: {}, listModels: async () => models,
  }, { run: callback => callback() }, {}, fakeTabTools)
  panel.loading = false
  panel.prompt = '/model'
  await panel.send()
  assert.equal(panel.modelPickerOpen, true)
  assert.deepEqual(panel.models, models)
  assert.equal(panel.prompt, '')
  await panel.chooseModel('model-a')
  assert.equal(settings.model, 'model-a')
  assert.equal(saved, 1)
  assert.equal(panel.modelPickerOpen, false)
})

test('selecting Codex default saves its concrete model for an existing session', async () => {
  const settings = { model: 'old-model' }
  const panel = new CodexPanelComponent({ store: { codexAgent: settings }, save: async () => {} }, {
    client: {}, listModels: async () => [{ model: 'new-default', displayName: 'Default', isDefault: true }],
  }, { run: callback => callback() }, {}, fakeTabTools)
  await panel.openModelPicker()
  await panel.chooseModel('')
  assert.equal(settings.model, 'new-default')
  assert.equal(panel.modelPickerOpen, false)
})

test('selecting a model waits for its supported thinking level before saving both values', async () => {
  let saved = 0
  const model = { model: 'new-model', displayName: 'New', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [
    { reasoningEffort: 'medium', description: 'Default' }, { reasoningEffort: 'ultra', description: 'Thorough' },
  ] }
  const settings = { model: 'old-model', reasoningEffort: 'low' }
  const panel = new CodexPanelComponent({ store: { codexAgent: settings }, save: async () => { saved++ } }, {
    client: {}, listModels: async () => [model],
  }, { run: callback => callback() }, {}, fakeTabTools)
  await panel.openModelPicker()
  await panel.selectModel('new-model')
  assert.equal(panel.pendingModel, model)
  assert.equal(panel.modelPickerOpen, true)
  assert.equal(settings.model, 'old-model')
  assert.equal(saved, 0)
  await panel.chooseModel('new-model', 'ultra')
  assert.equal(settings.model, 'new-model')
  assert.equal(settings.reasoningEffort, 'ultra')
  assert.equal(saved, 1)
  assert.equal(panel.modelPickerOpen, false)
})

test('thinking level can change for the current model and unsupported values are rejected', async () => {
  const settings = { model: 'current', reasoningEffort: 'medium' }
  const panel = new CodexPanelComponent({ store: { codexAgent: settings }, save: async () => {} }, { client: {} }, { run: callback => callback() }, {}, fakeTabTools)
  panel.models = [{ model: 'current', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] }]
  await panel.chooseModel('current', 'high')
  assert.equal(settings.reasoningEffort, 'high')
  await panel.chooseModel('current', 'ultra')
  assert.equal(settings.reasoningEffort, 'high')
  assert.match(panel.modelError, /不支持/)
})

test('failed model save restores both model and thinking level', async () => {
  const settings = { model: 'old', reasoningEffort: 'high' }
  const panel = new CodexPanelComponent({ store: { codexAgent: settings }, save: async () => { throw new Error('disk full') } }, { client: {} }, { run: callback => callback() }, {}, fakeTabTools)
  panel.models = [{ model: 'new', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }]
  panel.modelPickerOpen = true
  await panel.selectModel('new')
  await panel.chooseModel('new', 'low')
  assert.equal(settings.model, 'old')
  assert.equal(settings.reasoningEffort, 'high')
  assert.equal(panel.modelPickerOpen, true)
  assert.match(panel.modelError, /disk full/)
})

test('slash commands work with Enter and arrow keys while ordinary Enter remains a newline', () => {
  const panel = new CodexPanelComponent({ store: { codexAgent: {} } }, { client: {} }, { run: callback => callback() }, {}, fakeTabTools)
  panel.loading = false
  let prevented = 0
  const event = (key, extra = {}) => ({ key, preventDefault: () => { prevented++ }, isComposing: false, shiftKey: false, ctrlKey: false, metaKey: false, ...extra })
  panel.onPromptChanged('/')
  panel.onPromptKeydown(event('ArrowDown'))
  assert.equal(panel.slashSelection, 1)
  panel.onPromptKeydown(event('ArrowUp'))
  assert.equal(panel.slashSelection, 0)
  panel.onPromptChanged('/sta')
  panel.onPromptKeydown(event('Enter'))
  assert.equal(panel.statusOpen, true)
  assert.equal(panel.prompt, '')
  panel.onPromptChanged('ordinary message')
  panel.onPromptKeydown(event('Enter'))
  assert.equal(prevented, 3)
  panel.onPromptChanged('/status')
  panel.onPromptKeydown(event('Escape'))
  assert.deepEqual(panel.visibleSlashCommands, [])
  panel.onPromptKeydown(event('Enter', { isComposing: true }))
  panel.onPromptKeydown(event('Enter', { shiftKey: true }))
  panel.loading = true
  panel.onPromptKeydown(event('Enter'))
  assert.equal(panel.prompt, '/status')
  assert.equal(prevented, 4)
})

test('/status shows reported thread details and never sends a turn', async () => {
  const calls = []
  const settings = { model: 'next-model', sandbox: 'read-only', approvalPolicy: 'on-request' }
  const panel = new CodexPanelComponent({ store: { codexAgent: settings } }, {
    client: { request: async (method, params) => {
      calls.push(method)
      if (method === 'account/rateLimits/read') return { ordinaryUsageAllowed: false, rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: null }, secondary: null } }
      assert.equal(params.threadId, 'thread-1')
      return { thread: { model: 'current-model', reasoningEffort: 'high', status: { type: 'active' } } }
    } },
    getGoal: async () => ({ status: 'active' }),
  }, { run: callback => callback() }, {}, fakeTabTools)
  panel.loading = false
  panel.connected = true
  panel.threadId = 'thread-1'
  panel.prompt = '/status'
  await panel.send()
  assert.equal(panel.statusOpen, true)
  assert.equal(panel.threadStatus.model, 'current-model')
  assert.equal(panel.threadStatus.reasoningEffort, 'high')
  assert.equal(panel.threadStateLabel, '活动中')
  assert.equal(panel.goalLabel, '进行中')
  assert.equal(panel.rateLimitLabel(panel.statusRateLimits.primary), '5 小时额度')
  assert.equal(panel.rateLimitValue(panel.statusRateLimits.primary), '已用 25%')
  assert.equal(panel.ordinaryUsageLabel, '不可用')
  assert.equal(settings.model, 'next-model')
  assert.deepEqual(calls, ['thread/read', 'account/rateLimits/read'])
})

test('/status shows thread details before a slow rate-limit response completes', async () => {
  let finishLimits
  const limits = new Promise(resolve => { finishLimits = resolve })
  const panel = new CodexPanelComponent({ store: { codexAgent: { model: '' } } }, {
    client: { request: async method => method === 'account/rateLimits/read' ? limits : { thread: { model: 'current', status: { type: 'idle' } } } },
    getGoal: async () => ({ status: 'active' }),
  }, { run: callback => callback() }, {}, fakeTabTools)
  panel.connected = true
  panel.threadId = 'thread-1'
  const opening = panel.openStatus()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(panel.threadStatus.model, 'current')
  assert.equal(panel.statusLoading, true)
  finishLimits({ ordinaryUsageAllowed: true, rateLimits: { primary: null, secondary: null } })
  await opening
  assert.equal(panel.statusLoading, false)
  assert.equal(panel.ordinaryUsageLabel, '可用')
})

test('/status reports a disconnected session as unavailable', async () => {
  const panel = new CodexPanelComponent({ store: { codexAgent: { model: '' } } }, { client: {} }, { run: callback => callback() }, {}, fakeTabTools)
  panel.loading = false
  panel.prompt = '/status'
  await panel.send()
  assert.equal(panel.statusOpen, true)
  assert.equal(panel.connectionLabel, '未连接')
  assert.equal(panel.turnLabel, '不可用')
})

test('status and history panels are mutually exclusive', async () => {
  const panel = new CodexPanelComponent({ store: { codexAgent: {} } }, {
    client: {}, listSessions: async () => ({ data: [], nextCursor: null }),
  }, { run: callback => callback() }, {}, fakeTabTools)
  panel.historyOpen = true
  await panel.openStatus()
  assert.equal(panel.statusOpen, true)
  assert.equal(panel.historyOpen, false)
  await panel.toggleHistory()
  assert.equal(panel.historyOpen, true)
  assert.equal(panel.statusOpen, false)
})

test('token usage events update the active session context gauge', () => {
  const panel = new CodexPanelComponent({ store: { codexAgent: {} } }, { client: {} }, { run: callback => callback() }, {}, fakeTabTools)
  panel.threadId = 'current'
  panel.handleEvent({ method: 'thread/tokenUsage/updated', params: { threadId: 'other', tokenUsage: { last: { totalTokens: 900 }, total: { totalTokens: 900 }, modelContextWindow: 1000 } } })
  assert.equal(panel.contextUsedTokens, null)
  panel.handleEvent({ method: 'thread/tokenUsage/updated', params: { threadId: 'current', tokenUsage: { last: { totalTokens: 250 }, total: { totalTokens: 2000 }, modelContextWindow: 1000 } } })
  assert.equal(panel.contextUsedTokens, 250)
  assert.equal(panel.contextWindowTokens, 1000)
  assert.equal(panel.sessionTotalTokens, 2000)
  assert.equal(panel.contextPercent, 25)
})

test('terminal takeover waits for an explicit choice and cancellation leaves the terminal alone', async () => {
  const panel = new CodexPanelComponent({ store: { codexAgent: {} } }, { client: {} }, { run: callback => callback() }, {}, fakeTabTools)
  const pending = panel.confirmTakeover({ tabId: 'tab-1', title: 'Build', processes: ['npm test'], purpose: 'Run tests', unknown: false })
  assert.equal(panel.request.method, 'local/terminalTakeover')
  assert.match(panel.request.title, /Build/)
  panel.decideTakeover('cancel')
  assert.equal(await pending, 'cancel')
  assert.equal(panel.request, undefined)
})

test('closing and reopening details ignores earlier in-flight status responses', async () => {
  const reads = []
  const panel = new CodexPanelComponent({ store: { codexAgent: {} } }, {
    client: { request: method => method === 'thread/read' ? new Promise(resolve => reads.push(resolve)) : Promise.resolve({}) },
    getGoal: async () => null,
  }, { run: callback => callback() }, {}, fakeTabTools)
  panel.connected = true
  panel.threadId = 'thread-1'
  panel.historyOpen = true
  const first = panel.toggleStatus()
  assert.equal(panel.historyOpen, false)
  await panel.toggleStatus()
  assert.equal(panel.statusOpen, false)
  const second = panel.toggleStatus()
  reads[1]({ thread: { model: 'new-snapshot' } })
  await second
  reads[0]({ thread: { model: 'stale-snapshot' } })
  await first
  assert.equal(panel.threadStatus.model, 'new-snapshot')
  assert.equal(panel.statusLoading, false)
})

test('summary release only releases terminals owned by this panel session', () => {
  const controls = [{ owner: 'thread-1', tabId: 'one' }, { owner: 'thread-2', tabId: 'two' }]
  const tabTools = { releaseOwner: owner => {
    for (let index = controls.length - 1; index >= 0; index--) if (controls[index].owner === owner) controls.splice(index, 1)
  } }
  const panel = new CodexPanelComponent({ store: { codexAgent: {} } }, { client: {} }, { run: callback => callback() }, {}, tabTools)
  panel.threadId = 'thread-1'
  panel.releaseControlledTabs()
  assert.deepEqual(controls, [{ owner: 'thread-2', tabId: 'two' }])
})
