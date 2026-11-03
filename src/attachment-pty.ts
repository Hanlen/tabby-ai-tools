import { randomUUID, createHash } from 'crypto'
import { Subscription } from 'rxjs'
import { AttachmentError, ATTACHMENT_LIMIT, checkTransfer } from './attachments'
import { TransferTarget, TransferData, attachmentShellQuote as q, attachmentDigestScript as digest, attachmentDecoderScript as decoder } from './attachment-transport'

/** A last-resort protocol for a positively identified idle shell. Never a screen scraper. */
export async function runAttachmentPty (target: TransferTarget, script: string, signal: AbortSignal,
  send: (text: string) => void, consume: (bytes: Buffer) => Promise<void>, input?: AsyncIterable<Buffer>): Promise<void> {
  const token = 'TA_' + randomUUID().replace(/-/g, '')
  const ready = token + '_READY', end = token + '_END', ack = token + '_ACK', done = token + '_DONE', pull = token + '_PULL'
  target.hideOutput?.(done)
  // A multiline quoted command can leave PS2 text before the first receiver output.
  const body = script.replace(/printf '__READY__/g, "printf '\\n__READY__").replace(/__READY__/g, ready).replace(/__END__/g, end).replace(/__ACK__/g, ack).replace(/__PULL__/g, pull)
  const subscriptions = new Subscription()
  let pending = '', begun = false, settled = false, queue = Promise.resolve(), inputDone = !input
  let releaseReady!: () => void, releaseAck: (() => void) | undefined
  const prepared = new Promise<void>(resolve => { releaseReady = resolve })
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      if (settled) return
      settled = true; clearTimeout(timer); subscriptions.unsubscribe(); signal.removeEventListener('abort', cancel)
      releaseReady(); releaseAck?.()
      if (error) reject(error); else resolve()
    }
    const cancel = () => finish(new AttachmentError('UNKNOWN', 'PTY transfer stopped; inspect the remote file and terminal state'))
    const timer = setTimeout(() => finish(new AttachmentError('UNKNOWN', 'PTY receiver timed out; its result is unknown')), 120000)
    subscriptions.add(target.session.output$.subscribe((value: string | Buffer) => {
      pending += Buffer.isBuffer(value) ? value.toString('utf8') : value
      if (pending.length > 65536 && !pending.includes('\n')) { finish(new Error('Invalid PTY transfer frame')); return }
      let newline: number
      while ((newline = pending.indexOf('\n')) >= 0 && !settled) {
        const line = pending.slice(0, newline).replace(/\r/g, ''); pending = pending.slice(newline + 1)
        if (line === ready) { begun = true; releaseReady(); continue }
        if (line.startsWith(done + ':')) {
          const status = line.slice(done.length + 1)
          queue.then(() => finish(status === '0' && inputDone ? undefined : new AttachmentError(status === '69' ? 'UNSUPPORTED' : 'FAILED', 'PTY receiver failed with status ' + status))).catch(finish)
          continue
        }
        if (!begun) continue
        if (line === pull) {
          queue = queue.then(() => { checkTransfer(signal); if (!settled && target.valid()) send(ack + '\n') }).catch(finish)
          continue
        }
        if (line === ack) { releaseAck?.(); releaseAck = undefined; continue }
        queue = queue.then(() => consume(Buffer.from(line + '\n'))).catch(finish)
      }
    }))
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) { cancel(); return }
    // trap restores echo even when the receiver fails; a foreground Agent is never interrupted.
    const wrapped = `saved=$(stty -g) || exit 70; stty -echo || exit 70; trap 'stty "$saved"' EXIT; /bin/sh -c ${q(body)}; code=$?; printf '\\n${done}:%s\\n' "$code"`
    send('/bin/sh -c ' + q(wrapped) + '\r')
    void (async () => {
      await prepared
      if (settled || !input) return
      for await (const bytes of input) {
        checkTransfer(signal)
        if (!target.valid()) throw new AttachmentError('UNKNOWN', 'PTY target changed')
        if (settled) return
        const wait = new Promise<void>(resolve => { releaseAck = resolve })
        send(bytes.toString('ascii') + ack + '\n')
        await wait
      }
      if (!settled) { inputDone = true; send(end + '\n') }
    })().catch(finish)
  })
}

export async function ptyTransfer (target: TransferTarget, data: TransferData, signal: AbortSignal): Promise<{ bytes: number; hash: string }> {
  if (!target.pty) throw new AttachmentError('UNSUPPORTED', 'No independent transfer channel; PTY fallback requires a verified idle shell. Keep the attachment and use an available shell without stopping the running Agent.')
  if (data.direction === 'upload') {
    const directory = data.remotePath.slice(0, data.remotePath.lastIndexOf('/')), temporary = directory + '/.part', encoded = directory + '/.encoded'
    const source = async function * () {
      let bytes = 0
      for await (const chunk of data.source!()) {
        yield Buffer.from(chunk.toString('base64').match(/.{1,512}/g)!.join('\n') + '\n')
        bytes += chunk.length; data.progress(bytes, data.size)
      }
      data.verifying()
    }
    let output = ''
    const script = `${decoder}\n${digest('/dev/null')} >/dev/null || exit $?\numask 077\nmkdir ${q(directory)} || exit $?\ntrap ${q('rm -f ' + q(temporary) + ' ' + q(encoded) + '; rmdir ' + q(directory) + ' 2>/dev/null')} EXIT\nset -C\n: > ${q(encoded)} || exit $?\nset +C\nprintf '__READY__\\n'\nwhile IFS= read -r line; do\ncase "$line" in __END__) break;; __ACK__) printf '__ACK__\\n';; *) printf '%s\\n' "$line" >> ${q(encoded)} || exit $?;; esac\ndone\n$decode < ${q(encoded)} > ${q(temporary)} || exit $?\nactual=$(${digest(temporary)}) || exit $?\ncase "$actual" in ${data.hash}*) ;; *) exit 66;; esac\ntest "$(wc -c < ${q(temporary)})" -eq ${data.size} || exit 66\ntest ! -e ${q(data.remotePath)} || exit 67\nmv ${q(temporary)} ${q(data.remotePath)} || exit $?\nprintf '%s\\n' "$actual"`
    await target.pty(script, signal, async bytes => { output += bytes.toString('utf8'); if (output.length > 8192) throw new Error('Invalid PTY upload result') }, source())
    if (!output.trim().startsWith(data.hash!)) throw new AttachmentError('UNKNOWN', 'PTY upload result was not verified')
    return { bytes: data.size!, hash: data.hash! }
  }
  let info = '', firstHash = '', expected = -1, bytes = 0, lastHash = ''
  const hash = createHash('sha256')
  const script = `test -f ${q(data.remotePath)} && ! test -L ${q(data.remotePath)} || exit 65\nsize=$(wc -c < ${q(data.remotePath)}) || exit $?\nactual=$(${digest(data.remotePath)}) || exit $?\nprintf '__READY__\\nMETA %s %s\\n' "$size" "$actual"\nbase64 < ${q(data.remotePath)} | (count=0; while IFS= read -r line || test -n "$line"; do printf '%s\\n' "$line"; count=$((count+1)); if test "$count" -eq 512; then printf '__PULL__\\n'; IFS= read -r reply < /dev/tty || exit 71; test "$reply" = '__ACK__' || exit 71; count=0; fi; done) || exit $?\nactual=$(${digest(data.remotePath)}) || exit $?\nprintf '\\nFINAL %s\\n' "$actual"`
  await target.pty(script, signal, async chunk => {
    info += chunk.toString('ascii')
    let newline: number
    while ((newline = info.indexOf('\n')) >= 0) {
      const line = info.slice(0, newline).trim(); info = info.slice(newline + 1)
      if (!line) continue
      if (line.startsWith('META ')) {
        const match = /^META\s+(\d+)\s+([a-f0-9]{64})\b/.exec(line)
        if (!match || expected >= 0) throw new Error('Invalid PTY metadata')
        expected = Number(match[1]); firstHash = match[2]
        if (expected > ATTACHMENT_LIMIT) throw new Error('Remote attachment exceeds 100 MiB')
        data.progress(0, expected); continue
      }
      if (line.startsWith('FINAL ')) { lastHash = /^FINAL ([a-f0-9]{64})\b/.exec(line)?.[1] || ''; data.verifying(); continue }
      if (expected < 0 || lastHash || !/^[A-Za-z0-9+/]+={0,2}$/.test(line) || line.length % 4) throw new Error('Invalid PTY base64 frame')
      const decoded = Buffer.from(line, 'base64'); bytes += decoded.length
      if (bytes > ATTACHMENT_LIMIT) throw new Error('PTY transfer exceeds 100 MiB')
      hash.update(decoded); await data.sink!(decoded); data.progress(bytes, expected)
    }
  })
  const actual = hash.digest('hex')
  if (expected !== bytes || actual !== firstHash || actual !== lastHash) throw new Error('PTY download failed SHA-256 verification')
  return { bytes, hash: actual }
}
