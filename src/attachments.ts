import { promises as fs, readdirSync, readFileSync, statSync } from 'fs'
import * as path from 'path'
import { createHash, randomUUID } from 'crypto'

export const ATTACHMENT_LIMIT = 100 * 1024 * 1024
export const IMAGE_LIMIT = 20 * 1024 * 1024
export interface Attachment {
  id: string; owner: string; name: string; mime: string; size: number; sha256: string; createdAt: number
}
export type TransferStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'
export interface AttachmentOperation {
  operationId: string; owner: string; tabId: string; target: string; remotePath: string; direction: 'upload' | 'download'
  status: TransferStatus; phase: 'queued' | 'transferring' | 'verifying' | 'finished'
  bytesTransferred: number; totalBytes?: number; transport?: 'sftp' | 'exec-binary' | 'exec-base64' | 'pty-base64'
  receipt?: { attachmentId: string; remotePath: string; bytes: number; sha256: string; verified: true }
  error?: string; createdAt: number
}
export class AttachmentError extends Error {
  constructor (public code: 'UNSUPPORTED' | 'FAILED' | 'UNKNOWN' | 'CANCELLED', message: string) { super(message) }
}
export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
export function checkTransfer (signal: AbortSignal): void {
  if (signal.aborted) throw new AttachmentError('CANCELLED', 'Transfer cancelled; inspect the receipt before retrying.')
}
export function safeRemotePath (value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('An absolute remote path without control characters is required')
  return path.posix.normalize(value)
}
export function attachmentName (name: string): string {
  return path.basename(name.replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '_').slice(0, 180) || 'attachment'
}

/** The model receives metadata, never an arbitrary local pathname or payload. */
export class AttachmentStore {
  private entries = new Map<string, Attachment>()
  constructor (readonly root: string) {
    // Receipts survive restarts, but never restore or resume a transfer implicitly.
    try {
      for (const name of readdirSync(root).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).slice(0, 2000)) {
        try {
          const item = JSON.parse(readFileSync(path.join(root, name), 'utf8')) as Attachment
          if (item.id + '.json' !== name || typeof item.owner !== 'string' || typeof item.name !== 'string' || typeof item.mime !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > ATTACHMENT_LIMIT || statSync(this.file(item.id)).size !== item.size) continue
          this.entries.set(item.id, item)
        } catch { /* Ignore incomplete metadata, never expose an unverified cache entry. */ }
      }
    } catch (error: any) { if (error.code !== 'ENOENT') throw error }
  }
  private async remember (item: Attachment): Promise<void> {
    await fs.writeFile(this.file(item.id) + '.json', JSON.stringify(item), { flag: 'wx', mode: 0o600 })
    this.entries.set(item.id, item)
  }
  async stage (owner: string, name: string, mime: string, bytes: Uint8Array): Promise<Attachment> {
    if (!owner) throw new Error('Attachment owner is required')
    if (bytes.byteLength > (mime.startsWith('image/') ? IMAGE_LIMIT : ATTACHMENT_LIMIT)) throw new Error('Attachment exceeds the file size limit')
    if (this.list(owner).length >= 8 || this.list(owner).reduce((sum, item) => sum + item.size, 0) + bytes.byteLength > 200 * 1024 * 1024) throw new Error('Attachment limit: 8 files / 200 MiB per session')
    const item: Attachment = { id: randomUUID(), owner, name: attachmentName(name), mime: mime || 'application/octet-stream', size: bytes.byteLength, sha256: sha256(bytes), createdAt: Date.now() }
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 })
    await fs.writeFile(this.file(item.id), bytes, { flag: 'wx', mode: 0o600 })
    await this.remember(item)
    return { ...item }
  }
  list (owner: string): Attachment[] { return [...this.entries.values()].filter(item => item.owner === owner).map(item => ({ ...item })) }
  get (owner: string, id: string): Attachment {
    const item = this.entries.get(id)
    if (!item || item.owner !== owner) throw new Error('Attachment is unavailable in this session; add it again if Tabby restarted')
    return { ...item }
  }
  file (id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid attachment ID')
    return path.join(this.root, id)
  }
  async remove (owner: string, id: string): Promise<void> {
    this.get(owner, id)
    await fs.unlink(this.file(id))
    await fs.unlink(this.file(id) + '.json').catch(() => undefined)
    this.entries.delete(id)
  }
  async accept (owner: string, id: string, name: string, size: number, hash: string): Promise<Attachment> {
    if (this.list(owner).length >= 8 || this.list(owner).reduce((sum, item) => sum + item.size, 0) + size > 200 * 1024 * 1024) throw new Error('Attachment cache limit reached')
    const stat = await fs.stat(this.file(id))
    if (!stat.isFile() || stat.size !== size || size > ATTACHMENT_LIMIT) throw new Error('Invalid received attachment')
    const item: Attachment = { id, owner, name: attachmentName(name), mime: /\.png$/i.test(name) ? 'image/png' : /\.jpe?g$/i.test(name) ? 'image/jpeg' : 'application/octet-stream', size, sha256: hash, createdAt: Date.now() }
    await this.remember(item)
    return { ...item }
  }
  async *chunks (owner: string, id: string, signal: AbortSignal): AsyncGenerator<Buffer> {
    this.get(owner, id)
    const file = await fs.open(this.file(id), 'r')
    try {
      for (;;) {
        checkTransfer(signal)
        const bytes = Buffer.alloc(48 * 1024)
        const result = await file.read(bytes, 0, bytes.length, null)
        if (!result.bytesRead) break
        yield bytes.subarray(0, result.bytesRead)
      }
    } finally { await file.close() }
  }
}

/** A tab has one native progress channel. Yield if another producer changes it. */
export class AttachmentTabProgress {
  private tasks = new Map<string, { bytes: number; total?: number; verifying: boolean }>()
  private subscription?: { unsubscribe(): void }
  private expected: number | null = null
  private writing = false
  private yielded = false
  private timer?: ReturnType<typeof setTimeout>
  private completionTimer?: ReturnType<typeof setTimeout>
  constructor (private tab: { setProgress?(value: number | null): void; progress$?: { subscribe(next: (value: number | null) => void): { unsubscribe(): void } } }) {}
  update (id: string, bytes: number, total?: number, verifying = false): void {
    if (this.completionTimer) { clearTimeout(this.completionTimer); this.completionTimer = undefined }
    if (!this.tasks.size && !this.subscription) {
      this.subscription = this.tab.progress$?.subscribe(value => {
        if (!this.writing && value !== this.expected && value !== null) this.yielded = true
      })
    }
    this.tasks.set(id, { bytes, total, verifying })
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = undefined; this.publish() }, 100)
  }
  private write (value: number | null): void {
    if (this.yielded) return
    this.expected = value; this.writing = true
    try { this.tab.setProgress?.(value) } finally { this.writing = false }
  }
  private publish (): void {
    const tasks = [...this.tasks.values()]
    if (!tasks.length || tasks.some(task => task.total === undefined)) return
    const total = tasks.reduce((sum, task) => sum + task.total!, 0)
    // TabHeader renders `progress + '%'`; its API comment incorrectly says 0..1.
    this.write(Math.min(99, total ? 100 * tasks.reduce((sum, task) => sum + task.bytes, 0) / total : 99))
  }
  finish (id: string, completed = false): void {
    this.tasks.delete(id)
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.tasks.size) { this.publish(); return }
    const clear = () => {
      this.completionTimer = undefined; this.write(null)
      this.subscription?.unsubscribe(); this.subscription = undefined
      this.yielded = false; this.expected = null
    }
    if (completed && !this.yielded) { this.write(100); this.completionTimer = setTimeout(clear, 500) } else clear()
  }
}
