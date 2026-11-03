import { Injectable, OnDestroy } from '@angular/core'
import { PlatformService } from 'tabby-core'
import { BehaviorSubject, Subscription } from 'rxjs'
import { promises as fs, readFileSync, statSync, readdirSync } from 'fs'
import * as path from 'path'
import { randomUUID, createHash } from 'crypto'
import { Attachment, AttachmentOperation, AttachmentStore, AttachmentTabProgress, AttachmentError, checkTransfer, safeRemotePath } from './attachments'
import { TransferTarget, TransferData, sftpTransfer, execTransfer } from './attachment-transport'
import { ptyTransfer } from './attachment-pty'

@Injectable()
export class AttachmentTransferService implements OnDestroy {
  readonly operations$ = new BehaviorSubject<AttachmentOperation[]>([])
  private store?: AttachmentStore
  private operations = new Map<string, { value: AttachmentOperation; controller: AbortController; finished: Promise<void>; fingerprint: string }>()
  private requests = new Map<string, string>()
  private progress = new WeakMap<object, AttachmentTabProgress>()
  private updateTimer?: ReturnType<typeof setTimeout>
  private writes = Promise.resolve()
  constructor (private platform: PlatformService) {}
  private get files (): AttachmentStore {
    if (!this.store) {
      const config = this.platform.getConfigPath()
      if (!config) throw new Error('Tabby configuration directory is unavailable')
      this.store = new AttachmentStore(path.join(path.dirname(config), 'tabby-agent-attachments'))
      try {
        const journals = readdirSync(this.store.root).filter(name => /^transfer-[a-f0-9-]{36}\.json$/.test(name))
          .sort((a, b) => statSync(path.join(this.store!.root, b)).mtimeMs - statSync(path.join(this.store!.root, a)).mtimeMs).slice(0, 200)
        for (const journal of journals.reverse()) {
          const file = path.join(this.store.root, journal)
          if (statSync(file).size > 16384) throw new Error('Attachment receipt exceeds its limit')
          const record = JSON.parse(readFileSync(file, 'utf8'))
          const value = record.value as AttachmentOperation
          if (!value || typeof value.operationId !== 'string' || typeof value.owner !== 'string' || typeof record.fingerprint !== 'string' || typeof record.requestKey !== 'string') throw new Error('Invalid attachment receipt')
          if (value.status === 'running') { value.status = 'unknown'; value.phase = 'finished'; value.error = 'Transfer interrupted or owned by another Tabby window. Inspect the saved target/window before retrying.' }
          this.operations.set(value.operationId, { value, fingerprint: record.fingerprint, controller: new AbortController(), finished: Promise.resolve() })
          this.requests.set(record.requestKey, value.operationId)
        }
        this.publish()
      } catch (error: any) { if (error.code !== 'ENOENT') { this.store = undefined; throw error } }
    }
    return this.store
  }
  private persist (value: AttachmentOperation): Promise<void> {
    const root = this.files.root
    const entry = this.operations.get(value.operationId)!
    const snapshot = JSON.stringify({ value, fingerprint: entry.fingerprint, requestKey: [...this.requests].find(([, id]) => id === value.operationId)?.[0] })
    const write = this.writes.catch(() => undefined).then(async () => {
      await fs.mkdir(root, { recursive: true, mode: 0o700 })
      const temporary = path.join(root, '.operations-' + randomUUID())
      try { await fs.writeFile(temporary, snapshot, { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, path.join(root, 'transfer-' + value.operationId + '.json')) }
      finally { await fs.unlink(temporary).catch(() => undefined) }
    })
    this.writes = write
    return write
  }
  stage (owner: string, name: string, mime: string, bytes: Uint8Array): Promise<Attachment> { return this.files.stage(owner, name, mime, bytes) }
  list (owner: string): Attachment[] { return this.files.list(owner) }
  async saveLocal (owner: string, id: string): Promise<void> {
    const item = this.files.get(owner, id)
    const download = await this.platform.startDownload(item.name, 0o600, item.size)
    if (!download) return
    const controller = new AbortController()
    try {
      for await (const chunk of this.files.chunks(owner, id, controller.signal)) {
        if (download.isCancelled()) { controller.abort(); break }
        await download.write(chunk)
      }
    } finally { download.close() }
  }
  async remove (owner: string, id: string): Promise<void> {
    if ([...this.operations.values()].some(entry => entry.value.status === 'running' && entry.value.owner === owner && entry.fingerprint.includes(id))) throw new Error('Wait for the active transfer before removing this attachment')
    await this.files.remove(owner, id)
  }
  private publish (defer = false): void {
    if (defer) {
      if (!this.updateTimer) this.updateTimer = setTimeout(() => { this.updateTimer = undefined; this.publish() }, 100)
      return
    }
    if (this.updateTimer) clearTimeout(this.updateTimer)
    this.updateTimer = undefined
    this.operations$.next([...this.operations.values()].map(entry => ({ ...entry.value, receipt: entry.value.receipt && { ...entry.value.receipt } })))
  }
  status (owner: string, id: string): AttachmentOperation {
    void this.files
    const entry = this.operations.get(id)
    if (!entry || entry.value.owner !== owner) throw new Error('Transfer is unavailable in this session')
    return { ...entry.value, receipt: entry.value.receipt && { ...entry.value.receipt } }
  }
  cancel (owner: string, id: string): AttachmentOperation {
    const result = this.status(owner, id)
    if (result.status === 'running') this.operations.get(id)!.controller.abort()
    return this.status(owner, id)
  }
  async wait (owner: string, id: string, timeoutMs = 1500): Promise<AttachmentOperation> {
    this.status(owner, id)
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([this.operations.get(id)!.finished, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs) })])
    if (timer) clearTimeout(timer)
    return this.status(owner, id)
  }
  start (owner: string, target: TransferTarget, direction: 'upload' | 'download', args: { attachmentId?: string; remotePath?: string; requestId: string }): AttachmentOperation {
    void this.files
    if (!owner || typeof args.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(args.requestId)) throw new Error('A stable requestId is required')
    const attachment = direction === 'upload' ? this.files.get(owner, args.attachmentId!) : undefined
    const requested = direction === 'download' ? safeRemotePath(args.remotePath) : args.remotePath ? safeRemotePath(args.remotePath) : '/tmp'
    const fingerprint = JSON.stringify([direction, target.tabId, requested, attachment?.id])
    const key = owner + ':' + args.requestId, existingId = this.requests.get(key)
    if (existingId) {
      const existing = this.operations.get(existingId)!
      if (existing.fingerprint !== fingerprint) throw new Error('requestId already belongs to a different transfer')
      return this.status(owner, existingId)
    }
    if ([...this.operations.values()].filter(entry => entry.value.status === 'running').length >= 4) throw new Error('At most four attachment transfers may run at once')
    if (direction === 'download' && this.files.list(owner).length >= 8) throw new Error('Remove an attachment before downloading another file')
    // Bound session-only receipts; never evict running operations or lose their idempotency keys.
    if (this.operations.size >= 200) {
      const oldest = [...this.operations.values()].find(entry => ['completed', 'failed', 'cancelled'].includes(entry.value.status))
      if (!oldest) throw new Error('Inspect unresolved attachment transfers before creating more operations')
      this.operations.delete(oldest.value.operationId)
      for (const [key, id] of this.requests) if (id === oldest.value.operationId) this.requests.delete(key)
    }
    const operationId = randomUUID()
    const extension = attachment && /\.(png|jpe?g|webp|gif|pdf|zip|txt|json|csv|log)$/i.exec(attachment.name)?.[0] || '.bin'
    const remotePath = direction === 'upload' ? path.posix.join(requested, 'tabby-ai-' + operationId, 'attachment' + extension) : requested
    const value: AttachmentOperation = { operationId, owner, tabId: target.tabId, target: target.title, remotePath, direction, status: 'running', phase: 'queued', bytesTransferred: 0, totalBytes: attachment?.size, createdAt: Date.now() }
    const controller = new AbortController(), entry = { value, controller, fingerprint, finished: Promise.resolve() }
    this.operations.set(operationId, entry); this.requests.set(key, operationId)
    // Defer until entry is fully registered so synchronous errors are still observable.
    const timeout = setTimeout(() => controller.abort(), 120000)
    entry.finished = Promise.resolve().then(async () => { await this.persist(value); await this.run(target, value, attachment, remotePath, controller.signal) }).catch(async error => {
      value.status = error instanceof AttachmentError && error.code === 'UNKNOWN' ? 'unknown' : controller.signal.aborted ? 'cancelled' : 'failed'
      value.phase = 'finished'; value.error = String(error?.message || error).slice(0, 600)
      await this.persist(value).catch(() => { value.status = 'unknown'; value.error = 'Attachment receipt could not be saved. Inspect the remote path before retrying.' })
      this.publish()
    }).finally(() => clearTimeout(timeout))
    this.publish()
    return { ...value }
  }
  private async run (target: TransferTarget, value: AttachmentOperation, attachment: Attachment | undefined, remotePath: string, signal: AbortSignal): Promise<void> {
    checkTransfer(signal)
    if (!target.valid()) throw new AttachmentError('UNKNOWN', 'The selected SSH session is no longer connected')
    const subscriptions = new Subscription()
    const changed = () => { if (!target.valid()) this.operations.get(value.operationId)?.controller.abort() }
    subscriptions.add(target.tab.sessionChanged$?.subscribe(changed))
    subscriptions.add(target.session.closed$?.subscribe(changed))
    subscriptions.add(target.tab.destroyed$?.subscribe(() => this.operations.get(value.operationId)?.controller.abort()))
    target.ssh.ref?.()
    let progress = this.progress.get(target.tab)
    if (!progress) { progress = new AttachmentTabProgress(target.tab); this.progress.set(target.tab, progress) }
    const id = randomUUID()
    let file: fs.FileHandle | undefined, published = false
    const localHash = createHash('sha256'); let received = 0
    try {
      if (value.direction === 'download') {
        await fs.mkdir(this.files.root, { recursive: true, mode: 0o700 })
        file = await fs.open(this.files.file(id), 'wx', 0o600)
      }
      const data: TransferData = {
        direction: value.direction, remotePath, size: attachment?.size, hash: attachment?.sha256,
        source: attachment ? () => this.files.chunks(value.owner, attachment.id, signal) : undefined,
        sink: async bytes => {
          checkTransfer(signal)
          let offset = 0
          while (offset < bytes.length) {
            const result = await file!.write(bytes, offset, bytes.length - offset, null)
            if (!result.bytesWritten) throw new Error('Local attachment write returned zero bytes')
            offset += result.bytesWritten
          }
          received += bytes.length; localHash.update(bytes)
        },
        progress: (bytes, total) => {
          value.phase = 'transferring'; value.bytesTransferred = bytes
          if (total !== undefined) value.totalBytes = total
          progress!.update(value.operationId, bytes, value.totalBytes); this.publish(true)
        },
        verifying: () => { value.phase = 'verifying'; progress!.update(value.operationId, value.bytesTransferred, value.totalBytes, true); this.publish() },
      }
      let result: { bytes: number; hash: string } | undefined
      for (const transport of ['sftp', 'exec-binary', 'exec-base64', 'pty-base64'] as const) {
        checkTransfer(signal); value.transport = transport; this.publish()
        try {
          result = transport === 'sftp' ? await sftpTransfer(target, data, signal)
            : transport === 'pty-base64' ? await ptyTransfer(target, data, signal)
              : await execTransfer(target, data, signal, transport === 'exec-base64')
          break
        } catch (error) {
          if (!(error instanceof AttachmentError) || error.code !== 'UNSUPPORTED' || received) throw error
          if (transport === 'pty-base64') throw error
        }
      }
      if (!result) throw new Error('No attachment transport is available')
      checkTransfer(signal)
      if (!target.valid()) throw new AttachmentError('UNKNOWN', 'The SSH target changed before its receipt was recorded')
      if (file) {
        await file.sync(); await file.close(); file = undefined
        if (localHash.digest('hex') !== result.hash || received !== result.bytes) throw new Error('Local attachment failed integrity verification')
        await this.files.accept(value.owner, id, path.posix.basename(remotePath), result.bytes, result.hash)
      }
      published = true
      value.receipt = { attachmentId: attachment?.id || id, remotePath, bytes: result.bytes, sha256: result.hash, verified: true }
      value.status = 'completed'; value.phase = 'finished'; value.bytesTransferred = result.bytes; value.totalBytes = result.bytes
      try { await this.persist(value) } catch { value.status = 'unknown'; throw new AttachmentError('UNKNOWN', 'The file was verified but its receipt could not be saved; inspect the remote path') }
      this.publish()
    } finally {
      await file?.close().catch(() => undefined)
      if (value.direction === 'download' && !published) await fs.unlink(this.files.file(id)).catch(() => undefined)
      progress.finish(value.operationId, value.status === 'completed'); subscriptions.unsubscribe(); target.ssh.unref?.()
    }
  }
  ngOnDestroy (): void {
    if (this.updateTimer) clearTimeout(this.updateTimer)
    for (const entry of this.operations.values()) if (entry.value.status === 'running') entry.controller.abort()
  }
}
