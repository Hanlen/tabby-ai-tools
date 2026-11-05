import { promises as fs } from 'fs'
import * as path from 'path'
import { createHash, randomBytes } from 'crypto'

interface Log {
  id: string; scope: string; streamId: string; createdAt: number; status: string
  segments: string[]; lengths?: number[]; chars: number; bytes: number; reason?: string
}
/** Private, bounded text artifacts. Never subscribes to raw terminal output. */
export class TerminalLogStore {
  private logs = new Map<string, Log>()
  private queue: Promise<void> = Promise.resolve()
  private pending = 0
  private buffered = new Map<string, string>()
  private total = 0
  private ready: Promise<void>
  private unavailable = false
  private pins = new Map<string, number>()
  constructor (private root: string) { this.ready = this.restore().catch(() => { this.unavailable = true }) }
  private scope (scope: string): string { return createHash('sha256').update(scope).digest('hex') }
  private async restore (): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 })
    if (!(await fs.lstat(this.root)).isDirectory()) throw new Error('Invalid log directory')
    const names = await fs.readdir(this.root)
    for (const name of names.filter(n => /^[a-f0-9]{32}\.json$/.test(n)).slice(0, 2000)) {
      try {
        const file = path.join(this.root, name), stat = await fs.lstat(file)
        if (!stat.isFile() || stat.size > 1024 * 1024) continue
        const log: Log = JSON.parse(await fs.readFile(file, 'utf8'))
        if (log.id + '.json' !== name || !/^[a-f0-9]{64}$/.test(log.scope) || !Array.isArray(log.segments) || log.segments.some(n => !new RegExp('^' + log.id + '-[0-9]+\\.txt$').test(n)) || !Number.isSafeInteger(log.bytes) || log.bytes < 0 || log.bytes > 32 * 1024 * 1024) continue
        if (!Number.isSafeInteger(log.chars) || log.chars < 0 || !Number.isFinite(log.createdAt) || !Array.isArray(log.lengths) || log.lengths.length !== log.segments.length || log.lengths.some(n => !Number.isSafeInteger(n) || n < 0 || n > 1024 * 1024) || log.lengths.reduce((a, b) => a + b, 0) !== log.chars) continue
        if (Date.now() - log.createdAt > 7 * 86400000) {
          for (const segment of log.segments) await fs.unlink(path.join(this.root, segment)).catch(() => undefined)
          await fs.unlink(file); continue
        }
        if (log.status === 'recording') { log.status = 'interrupted'; log.reason = 'Host restarted' }
        this.logs.set(log.id, log); this.total += log.bytes
      } catch { /* Invalid manifests are never exposed. */ }
    }
    const retained = new Set([...this.logs.values()].flatMap(log => log.segments))
    for (const name of names) {
      const orphan = /^[a-f0-9]{32}-[0-9]+\.txt$/.test(name) && !retained.has(name)
      const temporary = /^[a-f0-9]{32}\.json\.[a-f0-9]+\.tmp$/.test(name)
      if (orphan || temporary) {
        const file = path.join(this.root, name)
        const stat = await fs.lstat(file).catch(() => undefined)
        // A second host may still be committing a new segment: never remove fresh files.
        if (stat && Date.now() - stat.mtimeMs > 7 * 86400000) await fs.unlink(file).catch(() => undefined)
      }
    }
  }
  private prune (): void {
    for (const log of [...this.logs.values()]) {
      if (log.status === 'recording' || this.pins.has(log.id) || Date.now() - log.createdAt <= 7 * 86400000) continue
      // Reclaim metadata synchronously so start() can reserve a slot. Delete on
      // the write queue after pending appends/finish have committed their files.
      this.logs.delete(log.id)
      this.enqueue(async () => {
        for (const name of log.segments) await fs.unlink(path.join(this.root, name)).catch(() => undefined)
        await fs.unlink(path.join(this.root, log.id + '.json')).catch(() => undefined)
        this.total -= log.bytes
      })
    }
  }
  private wait<T> (operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return operation
    return new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('Agent task was stopped')) }
      signal.addEventListener('abort', abort, { once: true })
      operation.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
      if (signal.aborted) abort()
    })
  }
  private enqueue (operation: () => Promise<void>): void {
    this.queue = this.queue.then(() => this.ready).then(async () => {
      if (this.unavailable) { for (const log of this.logs.values()) { log.status = 'partial'; log.reason = 'Storage unavailable' }; return }
      await operation()
    }).catch(() => undefined)
  }
  start (scope: string, streamId: string): string {
    this.prune()
    const id = randomBytes(16).toString('hex')
    const log: Log = { id, scope: this.scope(scope), streamId, createdAt: Date.now(), status: 'recording', segments: [], chars: 0, bytes: 0 }
    if (this.logs.size >= 2000) throw new Error('Log metadata capacity reached')
    this.logs.set(id, log)
    this.enqueue(async () => { await this.save(log) })
    return id
  }
  private async save (log: Log): Promise<void> {
    const target = path.join(this.root, log.id + '.json'), temp = target + '.' + randomBytes(8).toString('hex') + '.tmp'
    try {
      await fs.writeFile(temp, JSON.stringify(log), { mode: 0o600, flag: 'wx' })
      await fs.rename(temp, target)
    } finally { await fs.unlink(temp).catch(() => undefined) }
  }
  append (id: string, text: string): void {
    const log = this.logs.get(id)
    if (!log || log.status !== 'recording') return
    const size = Buffer.byteLength(text), previous = this.buffered.get(id)
    if (size + Buffer.byteLength(previous || '') > 1024 * 1024 || this.pending + size > 8 * 1024 * 1024) { this.finish(id, 'partial', 'Write queue limit'); return }
    this.pending += size; this.buffered.set(id, (previous || '') + text)
    if (previous !== undefined) return
    this.enqueue(async () => {
      const batch = this.buffered.get(id) || ''; this.buffered.delete(id)
      const bytes = Buffer.byteLength(batch)
      try {
        if (log.bytes + bytes > 32 * 1024 * 1024 || this.total + bytes > 256 * 1024 * 1024 || this.logs.size > 2000 || log.segments.length >= 2048) { log.status = 'partial'; log.reason = 'Storage limit'; await this.save(log); return }
        const name = id + '-' + log.segments.length + '.txt'
        await fs.writeFile(path.join(this.root, name), batch, { flag: 'wx', mode: 0o600 })
        const next = { ...log, segments: [...log.segments, name], lengths: [...(log.lengths || []), batch.length], chars: log.chars + batch.length, bytes: log.bytes + bytes }
        await this.save(next)
        Object.assign(log, next); this.total += bytes
      } catch { log.status = 'partial'; log.reason = 'Write failed' }
      finally { this.pending -= bytes }
    })
  }
  finish (id: string, status = 'sealed', reason?: string): void {
    const log = this.logs.get(id)
    if (!log) return
    if (log.status === 'recording') log.status = status
    if (reason) log.reason = reason
    this.enqueue(async () => {
      if (log.status === 'recording') log.status = status
      if (reason) log.reason = reason
      await this.save(log)
    })
  }
  async list (scope: string): Promise<any[]> {
    await this.ready
    if (this.unavailable) throw new Error('Log storage unavailable')
    return [...this.logs.values()].filter(l => l.scope === this.scope(scope)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100).map(l => ({ logId: l.id, streamId: l.streamId, createdAt: l.createdAt, status: l.status, chars: l.chars, reason: l.reason, captureStartedLate: true }))
  }
  private async readPage (scope: string, id: string, offset: number, limit: number, end?: number, signal?: AbortSignal): Promise<any> {
    await this.wait(this.ready, signal)
    if (this.unavailable) throw new Error('Log storage unavailable')
    const pending = this.queue; await this.wait(pending, signal)
    const log = this.logs.get(id)
    if (!log || log.scope !== this.scope(scope)) throw new Error('Log unavailable')
    if (Date.now() - log.createdAt > 7 * 86400000) throw new Error('Log expired')
    const high = Math.min(end ?? log.chars, log.chars)
    let position = 0, text = ''
    for (const [segmentIndex, name] of log.segments.entries()) {
      if (signal?.aborted) throw new Error('Agent task was stopped')
      const length = log.lengths?.[segmentIndex]
      if (length !== undefined && position + length <= offset) { position += length; continue }
      const file = path.join(this.root, name), stat = await fs.lstat(file)
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Log corrupt')
      const part = await fs.readFile(file, { encoding: 'utf8', signal })
      if (length !== undefined && part.length !== length) throw new Error('Log corrupt')
      if (position <= offset && offset < position + part.length && /[\udc00-\udfff]/.test(part[offset - position])) offset++
      if (position + part.length > offset && position < high) text += part.slice(Math.max(0, offset - position), Math.min(part.length, high - position, offset + limit - position))
      position += part.length
      if (text.length >= limit || position >= high) break
    }
    if (text && /[\ud800-\udbff]/.test(text[text.length - 1])) text = text.slice(0, -1)
    return { text, offset: offset + text.length, readEnd: high, hasMore: offset + text.length < high, logState: log.status, reason: log.reason, captureStartedLate: true }
  }
  async read (scope: string, id: string, offset: number, limit: number, end?: number, signal?: AbortSignal): Promise<any> {
    this.pins.set(id, (this.pins.get(id) || 0) + 1)
    try { return await this.readPage(scope, id, offset, limit, end, signal) }
    finally { const count = (this.pins.get(id) || 1) - 1; if (count) this.pins.set(id, count); else this.pins.delete(id) }
  }
  async flush (): Promise<void> { await this.queue; await this.ready }
}
