import { createHash, randomUUID } from 'crypto'
import { Subscription } from 'rxjs'
import { ATTACHMENT_LIMIT, AttachmentError, checkTransfer, safeRemotePath } from './attachments'
import { retainAttachmentChannel } from './attachment-channel'

export interface TransferTarget {
  tabId: string; title: string; tab: any; ssh: any; session: any
  valid(): boolean
  hideOutput?(doneMarker: string): void
  pty?: (script: string, signal: AbortSignal, consume: (bytes: Buffer) => Promise<void>, input?: AsyncIterable<Buffer>) => Promise<void>
}
export interface TransferData {
  direction: 'upload' | 'download'; remotePath: string; size?: number; hash?: string
  source?: () => AsyncIterable<Buffer>; sink?: (bytes: Buffer) => Promise<void>
  progress(bytes: number, total?: number): void
  verifying(): void
}
const quote = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'"
const unavailableSftp = new WeakSet<object>()
function valid (target: TransferTarget, signal: AbortSignal): void {
  checkTransfer(signal)
  if (!target.valid()) throw new AttachmentError('UNKNOWN', 'The target SSH session changed; verify the remote file before retrying')
}
function unsupported (error: any): boolean {
  return /unsupported|not supported|subsystem.*(failed|reject|unavailable)|unknown subsystem|not implemented/i.test(String(error?.message || error))
}
function limited (size: number): void { if (!Number.isSafeInteger(size) || size < 0 || size > ATTACHMENT_LIMIT) throw new Error('Remote file exceeds 100 MiB or has an invalid size') }
async function interruptible<T> (promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new AttachmentError('UNKNOWN', 'Transfer interrupted; inspect the remote state')
  return new Promise<T>((resolve, reject) => {
    const cancel = () => { signal.removeEventListener('abort', cancel); reject(new AttachmentError('UNKNOWN', 'Transfer interrupted; a remote operation may have occurred')) }
    signal.addEventListener('abort', cancel, { once: true })
    promise.then(value => { signal.removeEventListener('abort', cancel); resolve(value) }, error => { signal.removeEventListener('abort', cancel); reject(error) })
  })
}

export async function sftpTransfer (target: TransferTarget, data: TransferData, signal: AbortSignal): Promise<{ bytes: number; hash: string }> {
  if (typeof target.ssh?.openSFTP !== 'function' || unavailableSftp.has(target.ssh)) throw new AttachmentError('UNSUPPORTED', 'SFTP is unavailable on this connection')
  let sftp: any
  try { sftp = await interruptible(Promise.resolve(target.ssh.openSFTP()), signal) } catch (error) {
    // The native host reports a rejected/missing subsystem as a bare Timeout.
    // No file operation has started here; a live connection may try independent exec.
    if (unsupported(error) || /^Timeout$/i.test(String((error as any)?.message || error).trim()) && target.valid()) {
      unavailableSftp.add(target.ssh)
      throw new AttachmentError('UNSUPPORTED', 'SFTP capability was unavailable before any file operation')
    }
    throw error
  }
  valid(target, signal)
  const handles = new Set<any>()
  const open = async (file: string, flags: number) => {
    const handle = await interruptible(Promise.resolve(sftp.open(file, flags)).then(async (handle: any) => {
      if (signal.aborted) { await handle.close().catch(() => undefined); throw new AttachmentError('UNKNOWN', 'The transfer was cancelled while opening a file') }
      return handle
    }), signal)
    handles.add(handle); return handle
  }
  const close = async (handle: any) => { await interruptible(Promise.resolve(handle.close()), signal); handles.delete(handle) }
  let directory = '', temporary = '', published = false, ownsDirectory = false
  const cancel = () => { for (const handle of handles) void handle.close().catch(() => undefined) }
  signal.addEventListener('abort', cancel, { once: true })
  const read = async (file: string, sink?: (bytes: Buffer) => Promise<void>) => {
    const handle = await open(file, 1), hash = createHash('sha256')
    let bytes = 0
    try {
      for (;;) {
        valid(target, signal)
        const chunk = Buffer.from(await interruptible<Uint8Array>(Promise.resolve(handle.read()), signal))
        if (!chunk.length) break
        bytes += chunk.length; limited(bytes); hash.update(chunk)
        await sink?.(chunk)
        if (sink) data.progress(bytes)
      }
      return { bytes, hash: hash.digest('hex') }
    } finally { await close(handle) }
  }
  try {
    if (data.direction === 'download') {
      const before = await interruptible<any>(Promise.resolve(sftp.stat(data.remotePath)), signal)
      if (before.isDirectory || before.isSymlink) throw new Error('Download requires a regular file')
      limited(before.size); data.progress(0, before.size)
      const received = await read(data.remotePath, data.sink)
      data.verifying()
      const checked = await read(data.remotePath)
      const after = await interruptible<any>(Promise.resolve(sftp.stat(data.remotePath)), signal)
      if (received.bytes !== before.size || checked.hash !== received.hash || after.size !== before.size || Number(after.modified) !== Number(before.modified)) throw new Error('Remote file changed during transfer; no verified attachment was created')
      return received
    }
    // Each upload owns a fresh private directory. Its final path is unique and never overwrites user files.
    directory = data.remotePath.substring(0, data.remotePath.lastIndexOf('/'))
    if (typeof target.ssh?.ssh?.openSessionChannel === 'function') {
      // russh 0.1.38 chmod replays the complete stat, including directory size;
      // OpenSSH rejects that SETSTAT. Create with umask on a separate channel.
      // This is preparation, not fallback after a denied permission operation.
      await execStream(target, `umask 077\nmkdir ${quote(directory)}`, signal, async () => {})
    } else { await interruptible(Promise.resolve(sftp.mkdir(directory)), signal); await interruptible(Promise.resolve(sftp.chmod(directory, 0o700)), signal) }
    ownsDirectory = true
    temporary = directory + '/.part-' + randomUUID()
    const handle = await open(temporary, 2 | 8 | 32)
    await interruptible(Promise.resolve(sftp.chmod(temporary, 0o600)), signal)
    let bytes = 0
    for await (const chunk of data.source!()) {
      valid(target, signal)
      await interruptible(Promise.resolve(handle.write(chunk)), signal); bytes += chunk.length; limited(bytes); data.progress(bytes, data.size)
    }
    await close(handle); data.verifying()
    const checked = await read(temporary)
    if (bytes !== data.size || checked.bytes !== data.size || checked.hash !== data.hash) throw new Error('Uploaded attachment failed SHA-256 verification')
    valid(target, signal)
    try { await interruptible(Promise.resolve(sftp.rename(temporary, data.remotePath)), signal) } catch { throw new AttachmentError('UNKNOWN', 'SFTP publish was not confirmed; inspect the unique destination before retrying') }
    published = true
    return checked
  } finally {
    signal.removeEventListener('abort', cancel)
    await Promise.all([...handles].map(handle => handle.close().catch(() => undefined)))
    if (temporary && !published && target.valid()) await sftp.unlink(temporary).catch(() => undefined)
    if (ownsDirectory && !published && target.valid()) await sftp.rmdir(directory).catch(() => undefined)
  }
}

/** One non-PTY exec channel. Payload is streamed to disk; only a small trailer is buffered. */
export async function execStream (target: TransferTarget, script: string, signal: AbortSignal,
  sink: (bytes: Buffer) => Promise<void>, input?: AsyncIterable<Buffer>, ready = false): Promise<void> {
  valid(target, signal)
  const client = target.ssh?.ssh
  if (typeof client?.openSessionChannel !== 'function') throw new AttachmentError('UNSUPPORTED', 'Independent SSH exec is unavailable')
  let channel: any
  try { channel = await client.activateChannel(await client.openSessionChannel()) } catch (error) {
    if (unsupported(error)) throw new AttachmentError('UNSUPPORTED', 'SSH exec channels are not supported')
    throw error
  }
  if (input && typeof channel.write !== 'function') { await channel.close(); throw new AttachmentError('UNSUPPORTED', 'SSH stdin writing is unavailable') }
  const releaseBuffers = retainAttachmentChannel(client, channel)
  const token = 'TABBY_ATTACHMENT_' + randomUUID().replace(/-/g, '')
  const trailer = '\n' + token + ':'
  // requestExec uses the account's login shell. All actual syntax lives inside /bin/sh.
  const command = '/bin/sh -c ' + quote('/bin/sh -c ' + quote(script.replace(/__READY__/g, token + '_READY')) + '\nresult=$?\nprintf "\\n' + token + ':%s\\n" "$result"\nprintf "' + token + '_ERR\\n" >&2\nexit "$result"')
  const subscriptions = new Subscription()
  let releaseReady!: () => void
  const inputReady = new Promise<void>(resolve => { releaseReady = resolve })
  if (!ready) releaseReady()
  let tail = Buffer.alloc(0), errors = '', count = 0, queue = Promise.resolve(), settled = false, inputFinished = false, completing = false
  return new Promise<void>((resolve, reject) => {
    let drain: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: Error) => {
      if (settled) return
      settled = true; releaseReady(); clearTimeout(timeout); if (drain) clearTimeout(drain)
      signal.removeEventListener('abort', cancel); subscriptions.unsubscribe()
      releaseBuffers()
      void channel.close().catch(() => undefined)
      if (error) reject(error); else resolve()
    }
    const cancel = () => finish(new AttachmentError('UNKNOWN', 'Transfer stopped; the remote write may have occurred'))
    const timeout = setTimeout(() => finish(new AttachmentError('UNKNOWN', 'SSH transfer timed out; inspect the remote file')), 120000)
    const result = () => {
      if (completing) return true
      const text = tail.toString('utf8'), at = text.lastIndexOf(trailer)
      if (at < 0 || !errors.endsWith(token + '_ERR\n')) return false
      const match = /^(\d{1,3})\n$/.exec(text.slice(at + trailer.length))
      if (!match) return false
      completing = true
      // Buffer offsets must be byte offsets: marker itself is ASCII, payload may be arbitrary.
      const marker = tail.lastIndexOf(Buffer.from(trailer))
      const bytes = tail.subarray(0, marker)
      queue = queue.then(() => sink(bytes)).then(() => {
        if (Number(match[1]) !== 0) finish(new AttachmentError(/TABBY_UNSUPPORTED/.test(errors) ? 'UNSUPPORTED' : 'FAILED', 'Remote receiver failed: ' + errors.replace(token + '_ERR\n', '').trim().slice(0, 400)))
        else if (input && !inputFinished) finish(new AttachmentError('UNKNOWN', 'SSH receiver finished before the complete input was sent'))
        else finish()
      }).catch(finish)
      return true
    }
    subscriptions.add(channel.data$.subscribe({ next: (value: Uint8Array) => {
      if (settled) return
      count += value.length
      if (count > ATTACHMENT_LIMIT * 1.4 + 16384) { finish(new Error('Transfer output exceeds its limit')); return }
      tail = Buffer.concat([tail, Buffer.from(value)])
      if (ready) {
        const marker = Buffer.from(token + '_READY\n'), index = tail.indexOf(marker)
        if (index >= 0) { tail = Buffer.concat([tail.subarray(0, index), tail.subarray(index + marker.length)]); releaseReady() }
      }
      if (tail.length > 512) {
        const output = tail.subarray(0, tail.length - 512); tail = tail.subarray(tail.length - 512)
        queue = queue.then(() => { valid(target, signal); return sink(output) }).catch(finish)
      }
      if (!input || inputFinished) result()
    }, error: (error: Error) => finish(new AttachmentError('UNKNOWN', String(error))) }))
    subscriptions.add(channel.extendedData$.subscribe({ next: ([, bytes]: [number, Uint8Array]) => { errors = (errors + Buffer.from(bytes).toString('utf8')).slice(-4096); if (!input || inputFinished) result() }, error: (error: Error) => finish(new AttachmentError('UNKNOWN', String(error))) }))
    subscriptions.add(channel.closed$.subscribe({ next: () => {
      // Native queues can deliver close before data, particularly on Windows.
      drain = setTimeout(() => { if (!result()) finish(new AttachmentError('UNKNOWN', `SSH receiver did not return a complete result frame (received ${count} stdout bytes, ${errors.length} stderr characters)`)) }, 500)
    }, error: (error: Error) => finish(new AttachmentError('UNKNOWN', String(error))) }))
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) { cancel(); return }
    void channel.requestExec(command).then(async () => {
      await inputReady
      if (settled) return
      if (input) for await (const bytes of input) { valid(target, signal); if (settled) return; await channel.write(bytes) }
      inputFinished = true
      if (!settled) await channel.eof()
    }).catch((error: Error) => finish(new AttachmentError('UNKNOWN', error.message)))
  })
}

const digestScript = (file: string): string => `if command -v sha256sum >/dev/null 2>&1; then sha256sum ${quote(file)}; elif command -v shasum >/dev/null 2>&1; then shasum -a 256 ${quote(file)}; else printf TABBY_UNSUPPORTED >&2; exit 69; fi`
const decoderScript = "if printf 'eA==' | base64 -d >/dev/null 2>&1; then decode='base64 -d'; elif printf 'eA==' | base64 -D >/dev/null 2>&1; then decode='base64 -D'; else printf TABBY_UNSUPPORTED >&2; exit 69; fi"
export async function execTransfer (target: TransferTarget, data: TransferData, signal: AbortSignal, encoded: boolean): Promise<{ bytes: number; hash: string }> {
  const remote = safeRemotePath(data.remotePath)
  let result = ''
  const collect = async (bytes: Buffer) => { result += bytes.toString('utf8'); if (result.length > 8192) throw new Error('Receiver metadata exceeds its limit') }
  if (!encoded) {
    const probe = Buffer.from([0, 13, 10, 255, 128, 1, 66]), received: Buffer[] = []
    await execStream(target, "printf '__READY__\\n'; cat", signal, async bytes => { received.push(bytes) }, (async function * () { yield probe })(), true)
    if (!Buffer.concat(received).equals(probe)) throw new AttachmentError('UNSUPPORTED', 'The SSH exec byte round trip is not lossless')
  }
  if (data.direction === 'download') {
    // Hash first and again after streaming: changing source files are never published as verified.
    await execStream(target, `test -f ${quote(remote)} && ! test -L ${quote(remote)} || exit 65\nwc -c < ${quote(remote)}\n${digestScript(remote)}`, signal, collect)
    const match = /^\s*(\d+)\s*\n([a-f0-9]{64})\b/.exec(result)
    if (!match) throw new Error('Remote file metadata could not be verified')
    const size = Number(match[1]); limited(size); data.progress(0, size)
    const hash = createHash('sha256'); let bytes = 0, pending = ''
    const consume = async (chunk: Buffer) => {
      let decoded = chunk
      if (encoded) {
        pending += chunk.toString('ascii').replace(/\s/g, '')
        if (/[^A-Za-z0-9+/=]/.test(pending)) throw new Error('Invalid base64 transfer data')
        const length = Math.floor(pending.length / 4) * 4
        decoded = Buffer.from(pending.slice(0, length), 'base64'); pending = pending.slice(length)
      }
      bytes += decoded.length; limited(bytes); hash.update(decoded); await data.sink!(decoded); data.progress(bytes, size)
    }
    await execStream(target, encoded ? `base64 < ${quote(remote)}` : `cat ${quote(remote)}`, signal, consume)
    if (pending) throw new Error('Incomplete base64 transfer')
    data.verifying(); result = ''
    await execStream(target, digestScript(remote), signal, collect)
    const actual = hash.digest('hex')
    if (bytes !== size || actual !== match[2] || !result.startsWith(actual)) throw new Error('Remote file changed or failed SHA-256 verification')
    return { bytes, hash: actual }
  }
  const directory = remote.substring(0, remote.lastIndexOf('/')), temporary = directory + '/.part'
  const source = async function * () {
    let bytes = 0
    for await (const chunk of data.source!()) {
      valid(target, signal)
      yield encoded ? Buffer.from(chunk.toString('base64') + '\n') : chunk
      bytes += chunk.length; data.progress(bytes, data.size)
    }
    data.verifying()
  }
  // Probe the decoder and digest before any write. Capability failures alone allow another transport.
  await execStream(target, `${encoded ? decoderScript + '\n' : ''}${digestScript('/dev/null')}`, signal, collect)
  result = ''
  const script = `${encoded ? decoderScript + '\n' : ''}umask 077\nmkdir ${quote(directory)} || exit $?\ntrap ${quote('rm -f ' + quote(temporary) + '; rmdir ' + quote(directory) + ' 2>/dev/null')} EXIT\nset -C\n: > ${quote(temporary)} || exit $?\nprintf '__READY__\\n'\n${encoded ? '$decode' : 'cat'} > ${quote(temporary)} || exit $?\nactual=$(${digestScript(temporary)}) || exit $?\ncase "$actual" in ${data.hash}*) ;; *) printf 'SHA-256 mismatch' >&2; exit 66;; esac\ntest "$(wc -c < ${quote(temporary)})" -eq ${data.size} || exit 66\ntest ! -e ${quote(remote)} || exit 67\nmv ${quote(temporary)} ${quote(remote)} || exit $?\nprintf '%s\\n' "$actual"`
  // noclobber is only for exclusive creation. The known private file is then filled by its receiver.
  await execStream(target, script.replace("printf '__READY__", "set +C\nprintf '__READY__"), signal, collect, source(), true)
  if (!result.startsWith(data.hash!)) throw new AttachmentError('UNKNOWN', 'The upload result could not be verified')
  return { bytes: data.size!, hash: data.hash! }
}

export { quote as attachmentShellQuote, digestScript as attachmentDigestScript, decoderScript as attachmentDecoderScript }
