import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { McpPolicy, failure, randomId } from './policy.cjs'

const { app, ipcMain, utilityProcess } = require('electron')
const CHANNEL = 'tabby-ai-mcp-v1'
const singleton = Symbol.for('tabby-ai.mcp.host.v1')
export function install () {
  const globalState = globalThis as any
  if (globalState[singleton]) return
  if (!app.isReady() || typeof utilityProcess?.fork !== 'function' || Number(process.versions.node.split('.')[0]) < 20) throw new Error('MCP requires a Tabby host with Node 20+ and utilityProcess support')
  // The config-space key and renderer identity come from the host, never HTTP.
  const configSpace = realpathSync(process.env.TABBY_CONFIG_DIRECTORY || app.getPath('userData'))
  const policy = new McpPolicy(join(configSpace, 'ai-tools-mcp'))
  const expectedUrl = pathToFileURL(join(app.getAppPath(), 'dist/index.html')).href
  const owners = new Map<number, { sender: any; cleanup: () => void }>()
  const controls = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  const observations = new Map<string, { sender: any; target: string; clientId: string; revision: number; reject: (error: Error) => void; resolve: (value: any) => void; timer: ReturnType<typeof setTimeout>; callId: string }>()
  const exits = new WeakMap<object, Promise<void>>(), exitedChildren = new WeakSet<object>()
  let child: any, faulted: any, port = 0, error = '', utilityNode = '', chain = Promise.resolve(), stopping: Promise<void> | undefined
  const trusted = (event: any) => {
    try { return !event.sender.isDestroyed() && event.senderFrame === event.sender.mainFrame && event.sender.getURL() === expectedUrl } catch { return false }
  }
  const enqueue = <T,>(action: () => Promise<T>): Promise<T> => { const next = chain.then(action); chain = next.then(() => undefined, () => undefined); return next }
  const state = () => ({ ...policy.publicState(), running: !!child && !faulted && !!port, port: policy.port, endpoint: port ? `http://127.0.0.1:${port}/mcp` : '', error, hostNode: process.versions.node, utilityNode })
  const clearScopes = () => { for (const client of policy.clients.values()) { client.targets.clear(); client.revision++ } }
  const rejectControls = () => {
    for (const waiter of controls.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('MCP process unavailable')) }
    controls.clear()
  }
  const cancelObservation = (id: string, code: string, notify = true) => {
    const item = observations.get(id)
    if (!item) return
    observations.delete(id); clearTimeout(item.timer)
    // Settle first: a disappearing renderer must not strand this promise.
    item.reject(failure(code))
    if (notify) sendRenderer(item.sender, { type: 'cancel', id })
  }
  const dropOwner = (id: number) => {
    const owner = owners.get(id)
    if (!owner) return
    owner.cleanup(); owners.delete(id); policy.removeOwner(id)
    for (const [key, item] of observations) if (item.sender === owner.sender) cancelObservation(key, 'target_closed', false)
  }
  const sendRenderer = (sender: any, message: any): boolean => {
    try {
      if (sender.isDestroyed()) throw new Error('Renderer unavailable')
      sender.send(CHANNEL, message); return true
    } catch {
      if (owners.has(sender.id)) {
        dropOwner(sender.id)
        void enqueue(async () => { synchronize(); if (!owners.size) await stop() }).catch(() => undefined)
      }
      return false
    }
  }
  const faultChild = (own: any, message: string) => {
    if (child !== own || faulted === own || exitedChildren.has(own)) return
    // An error is not evidence of exit. Keep the slot until the exit event.
    faulted = own; port = 0; utilityNode = ''; error = message
    clearScopes()
    for (const id of observations.keys()) cancelObservation(id, 'cancelled')
    rejectControls()
    try { own.postMessage({ type: 'update', snapshot: { enabled: false, clients: [] } }) } catch { /* Termination below does not depend on IPC. */ }
    synchronize()
    void enqueue(async () => { await stop() }).catch(() => undefined)
  }
  const postChild = (own: any, message: any): boolean => {
    if (child !== own || exitedChildren.has(own)) return false
    try { own.postMessage(message); return true } catch {
      faultChild(own, 'MCP IPC failed. Waiting for process exit; no request was replayed.'); return false
    }
  }
  const synchronize = () => {
    if (child && !faulted) postChild(child, { type: 'update', snapshot: policy.snapshot() })
    for (const [id, item] of observations) {
      try { policy.authorize(item.clientId, item.revision, item.target) } catch { cancelObservation(id, 'permission_denied') }
    }
    for (const owner of owners.values()) sendRenderer(owner.sender, {
      type: 'state', state: state(),
      grants: policy.enabled && !faulted ? [...policy.clients.values()].flatMap(c => [...c.targets].map(id => policy.targets.get(id)).filter(t => t?.owner === owner.sender.id).map(t => ({ clientId: c.id, revision: c.revision, targetId: t!.id, key: t!.key, session: t!.session }))) : [],
    })
  }
  const control = (type: string, data: any = {}) => new Promise<any>((resolve, reject) => {
    const own = child
    if (!own) return reject(new Error('MCP process unavailable'))
    const id = randomId(), timer = setTimeout(() => { controls.delete(id); reject(new Error('MCP control observation timed out; no request replayed')) }, 5000)
    controls.set(id, { resolve, reject, timer })
    if (!postChild(own, { type, ...data, id })) {
      controls.delete(id); clearTimeout(timer); reject(new Error('MCP process unavailable'))
    }
  })
  const dispatch = async (message: any) => {
    if (faulted || !port) throw failure('cancelled')
    const client = policy.authorize(message.clientId, message.revision)
    if (message.tool === 'list_tabs') return [...client.targets].map(id => policy.targets.get(id)).filter(Boolean).map(t => ({ tabId: t!.id, title: t!.title }))
    if (message.tool !== 'read_tab' || !message.args || typeof message.args.tabId !== 'string') throw failure('permission_denied')
    policy.authorize(message.clientId, message.revision, message.args.tabId)
    const target = policy.targets.get(message.args.tabId)!, owner = owners.get(target.owner)
    if (!owner) throw failure('target_closed')
    if (observations.size >= 16) throw failure('busy')
    const value = await new Promise<any>((resolve, reject) => {
      const id = randomId(), timer = setTimeout(() => cancelObservation(id, 'observation_timeout'), 32000)
      observations.set(id, { sender: owner.sender, target: target.id, clientId: client.id, revision: client.revision, resolve, reject, timer, callId: message.id })
      if (!sendRenderer(owner.sender, { type: 'read', id, clientId: client.id, revision: client.revision, targetId: target.id, key: target.key, session: target.session, args: message.args })) cancelObservation(id, 'target_closed', false)
    })
    policy.authorize(message.clientId, message.revision, target.id)
    if (policy.targets.get(target.id) !== target) throw failure('target_stale')
    return value
  }
  const start = async () => {
    if (stopping) await stopping
    if (child) {
      if (faulted || !port) throw new Error(error || 'MCP process exit has not been observed')
      return
    }
    if (!policy.enabled || !owners.size) return
    error = ''
    let own: any
    try { own = utilityProcess.fork(join(__dirname, 'utility.cjs'), [], { stdio: 'pipe', serviceName: 'Tabby AI Tools — MCP', env: { NODE_OPTIONS: '', NODE_PATH: '', ELECTRON_RUN_AS_NODE: '', PATH: '' } }) }
    catch { error = 'MCP process could not be launched'; synchronize(); throw new Error(error) }
    child = own; faulted = undefined
    own.stdout?.resume(); own.stderr?.resume()
    let resolveExit: () => void
    exits.set(own, new Promise<void>(resolve => { resolveExit = resolve }))
    own.once('exit', () => {
      exitedChildren.add(own); resolveExit()
      if (child !== own) return
      child = undefined; faulted = undefined; port = 0; utilityNode = ''
      if (!stopping && policy.enabled && !error) error = 'MCP process exited. Disable and enable to restart; no request was replayed.'
      for (const id of observations.keys()) cancelObservation(id, 'cancelled')
      rejectControls(); clearScopes(); synchronize()
    })
    own.once('error', () => faultChild(own, 'MCP process failed. Waiting for process exit; no request was replayed.'))
    own.on('message', (message: any) => {
      if (child !== own || !message) return
      if (message.type === 'tool') {
        void dispatch(message).then(value => { postChild(own, { type: 'tool-result', id: message.id, value }) }, (error: any) => { postChild(own, { type: 'tool-result', id: message.id, error: error.code || 'internal_error' }) })
      } else if (message.type === 'cancel') {
        for (const [id, item] of observations) if (item.callId === message.id) cancelObservation(id, 'cancelled')
      } else if (message.type === 'activity' && !faulted) {
        const client = policy.clients.get(message.clientId)
        if (client) { client.lastSeen = new Date().toISOString(); synchronize() }
      } else if (message.type === 'control-result') {
        const waiter = controls.get(message.id)
        if (!waiter) return
        controls.delete(message.id); clearTimeout(waiter.timer)
        if (message.error) waiter.reject(new Error(message.error)); else waiter.resolve(message.value)
      }
    })
    try {
      const info = await control('start', { port: policy.port, snapshot: policy.snapshot() })
      if (child !== own || faulted) throw new Error('MCP process unavailable')
      port = info.port; utilityNode = info.node; policy.port = port; policy.save(); synchronize()
    } catch (failure: any) {
      error = failure.message === 'EADDRINUSE' ? 'MCP port is occupied. Disable the service and choose another port.' : error || 'MCP could not start: ' + failure.message
      await stop(); synchronize(); throw new Error(error)
    }
  }
  const stop = (): Promise<void> => stopping ||= (async () => {
    port = 0
    for (const id of observations.keys()) cancelObservation(id, 'cancelled')
    const own = child
    if (!own || exitedChildren.has(own)) return
    postChild(own, { type: 'update', snapshot: { enabled: false, clients: [] } })
    const exit = exits.get(own)!
    const kill = () => { if (child === own && !exitedChildren.has(own)) { try { own.kill() } catch { /* Exit, not kill's return value, decides completion. */ } } }
    const soft = setTimeout(kill, 250)
    const force = setTimeout(() => {
      if (child === own && !exitedChildren.has(own) && own.pid) { try { process.kill(own.pid, 'SIGKILL') } catch { /* Keep waiting for actual exit. */ } }
    }, 1500)
    let timeout: ReturnType<typeof setTimeout>
    const limit = new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('MCP process exit not observed. The process slot is retained; restart Tabby if it remains unavailable.')), 5000) })
    // Graceful close, normal kill and hard deadline run under one bounded budget.
    void control('stop').then(kill, kill)
    try { await Promise.race([exit, limit]) } catch (failure: any) {
      faulted = own; error = failure.message; clearScopes(); synchronize(); throw failure
    } finally { clearTimeout(soft); clearTimeout(force); clearTimeout(timeout!) }
  })().finally(() => { stopping = undefined })
  const commit = async () => {
    try { policy.save() } catch {
      policy.enabled = false; error = 'Could not save MCP permissions. Service disabled.'; synchronize(); await stop(); throw new Error(error)
    }
    synchronize()
  }
  const removeOwner = async (id: number) => { dropOwner(id); synchronize(); if (!owners.size) await stop() }
  ipcMain.on(CHANNEL + '-reply', (event: any, message: any) => {
    const item = observations.get(message?.id)
    if (!item || !trusted(event) || event.sender !== item.sender) return
    observations.delete(message.id); clearTimeout(item.timer)
    try {
      policy.authorize(item.clientId, item.revision, item.target)
      if (message.error) item.reject(failure(message.error))
      else if (Buffer.byteLength(JSON.stringify(message.value ?? null)) > 128 * 1024) item.reject(failure('internal_error'))
      else item.resolve(message.value)
    } catch { item.reject(failure('permission_denied')) }
  })
  ipcMain.handle(CHANNEL, (event: any, message: any) => enqueue(async () => {
    if (!trusted(event) || !message || typeof message.type !== 'string') throw new Error('Untrusted MCP control request')
    const sender = event.sender
    if (message.type === 'register') {
      if (!owners.has(sender.id)) {
        const gone = () => { void enqueue(() => removeOwner(sender.id)).catch(() => undefined) }
        owners.set(sender.id, { sender, cleanup: () => { sender.off('destroyed', gone); sender.off('render-process-gone', gone) } })
        sender.once('destroyed', gone); sender.once('render-process-gone', gone)
      }
      // Runtime startup is independent of registering this window's terminal feed.
      if (policy.enabled && !error) { try { await start() } catch { /* Return the recorded startup fault; the renderer stays registered. */ } }
      synchronize(); return state()
    }
    if (!owners.has(sender.id)) throw new Error('MCP renderer is not registered')
    let value: any
    if (message.type === 'targets') { policy.register(sender.id, message.targets); synchronize() }
    else if (message.type === 'state') return state()
    else if (message.type === 'enabled') {
      policy.enabled = message.enabled === true
      for (const client of policy.clients.values()) { client.revision++; if (!policy.enabled) client.targets.clear() }
      await commit()
      if (policy.enabled) await start(); else { error = ''; await stop() }
    } else if (message.type === 'port') {
      if (policy.enabled) throw new Error('Disable MCP before changing its port')
      if (!Number.isInteger(message.port) || message.port < 0 || message.port > 65535) throw new Error('Port must be between 0 and 65535')
      policy.port = message.port; await commit()
    } else if (message.type === 'add') { value = policy.add(message.name); await commit() }
    else if (message.type === 'rotate') { value = policy.rotate(message.id); await commit() }
    else if (message.type === 'revoke') { policy.client(message.id); policy.clients.delete(message.id); await commit() }
    else if (message.type === 'scope') { policy.setScope(message.id, message.targets); await commit() }
    else if (message.type === 'unregister') await removeOwner(sender.id)
    else throw new Error('Unknown MCP action')
    synchronize(); return value ?? state()
  }))
  app.once('before-quit', () => { try { child?.kill() } catch { /* Application shutdown also reaps the utility. */ } })
  globalState[singleton] = true
}
