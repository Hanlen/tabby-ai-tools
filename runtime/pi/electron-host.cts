import { EventEmitter } from 'node:events'
import { Writable, PassThrough } from 'node:stream'
import { join } from 'node:path'

// Loaded in Electron's main process through the host's existing remote bridge.
// SDK execution stays in a utility process; no system node executable is used.
const { app, utilityProcess, webContents } = require('electron')

export function inspect () {
  if (!app.isReady() || typeof utilityProcess?.fork !== 'function') throw new Error('Tabby does not support the Pi utility process')
  return { node: process.versions.node, electron: process.versions.electron }
}

export function fork (ownerId: number) {
  inspect()
  const owner = webContents.fromId(ownerId)
  if (!owner || owner.isDestroyed()) throw new Error('Pi owner window is unavailable')
  const child = utilityProcess.fork(join(__dirname, 'sidecar.mjs'), [], {
    stdio: 'pipe', serviceName: 'Tabby AI Tools — Pi',
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', ELECTRON_RUN_AS_NODE: '' },
  })
  const bridge = new EventEmitter() as EventEmitter & {
    stdin: Writable; stdout: PassThrough; stderr: PassThrough; terminate: () => Promise<void>
  }
  let closed = false, buffer = '', diagnostics = 0, stopping: Promise<void> | undefined
  bridge.stdout = new PassThrough()
  bridge.stderr = new PassThrough()
  // Retain a local error listener until the renderer attaches its handlers.
  bridge.on('error', () => undefined)
  bridge.stdin = new Writable({ write (chunk, _encoding, callback) {
    try {
      if (closed) throw new Error('Pi utility process has exited')
      buffer += chunk.toString()
      if (Buffer.byteLength(buffer) > 12 * 1024 * 1024) throw new Error('Pi protocol exceeded limit')
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
        child.postMessage(line)
      }
      callback()
    } catch (error) { callback(error as Error) }
  } })
  bridge.terminate = () => stopping ||= new Promise<void>((resolve, reject) => {
    if (closed) { resolve(); return }
    const force = setTimeout(() => {
      if (!closed && child.pid) {
        try { process.kill(child.pid, 'SIGKILL') } catch { /* Exit event determines completion. */ }
      }
    }, 1500)
    const timeout = setTimeout(() => { cleanup(); reject(new Error('Pi utility process did not exit')) }, 5000)
    const cleanup = () => { clearTimeout(force); clearTimeout(timeout); bridge.off('close', complete) }
    const complete = () => { cleanup(); resolve() }
    bridge.once('close', complete)
    child.kill()
  })
  const ownerGone = () => { void bridge.terminate().catch(() => undefined) }
  owner.once('destroyed', ownerGone)
  owner.once('render-process-gone', ownerGone)
  child.on('message', (message: unknown) => {
    if (typeof message !== 'string' || Buffer.byteLength(message) > 12 * 1024 * 1024) {
      bridge.emit('error', new Error('Pi protocol exceeded limit')); ownerGone(); return
    }
    bridge.stdout.write(message + '\n')
    try {
      const type = JSON.parse(message).type
      if (type === 'done' || type === 'fatal') child.postMessage('{"type":"shutdown"}')
    } catch { bridge.emit('error', new Error('Invalid Pi protocol')); ownerGone() }
  })
  const diagnostic = (chunk: Buffer, stderr: boolean) => {
    diagnostics += chunk.length
    if (diagnostics > 1024 * 1024) { bridge.emit('error', new Error('Pi diagnostics exceeded limit')); ownerGone() }
    else if (stderr) bridge.stderr.write(chunk)
  }
  child.stdout?.on('data', (chunk: Buffer) => diagnostic(chunk, false))
  child.stderr?.on('data', (chunk: Buffer) => diagnostic(chunk, true))
  child.once('error', () => { bridge.emit('error', new Error('Pi utility process failed')); ownerGone() })
  child.once('exit', (code: number) => {
    closed = true
    owner.off('destroyed', ownerGone)
    owner.off('render-process-gone', ownerGone)
    bridge.stdin.destroy()
    bridge.stdout.end()
    bridge.stderr.end()
    bridge.emit('close', code, null)
  })
  return bridge
}
