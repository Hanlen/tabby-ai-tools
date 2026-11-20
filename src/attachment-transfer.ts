import { AttachmentError, AttachmentOperation, checkTransfer } from './attachments'
import { execTransfer, sftpTransfer, TransferData, TransferTarget } from './attachment-transport'
import { ptyTransfer } from './attachment-pty'

type Transport = NonNullable<AttachmentOperation['transport']>

export async function transferAttachment (target: TransferTarget, data: TransferData, signal: AbortSignal, onTransport?: (transport: Transport) => void) {
  let payloadStarted = false
  const guarded: TransferData = {
    ...data,
    source: data.source && (async function * () { payloadStarted = true; yield * data.source!() }),
    sink: data.sink && (async bytes => { if (bytes.length) payloadStarted = true; await data.sink!(bytes) }),
  }
  for (const transport of ['sftp', 'exec-binary', 'exec-base64', 'pty-base64'] as const) {
    checkTransfer(signal)
    if (!target.valid()) throw new AttachmentError('UNKNOWN', 'The SSH target changed during file transfer')
    onTransport?.(transport)
    try {
      const result = transport === 'sftp' ? await sftpTransfer(target, guarded, signal)
        : transport === 'pty-base64' ? await ptyTransfer(target, guarded, signal)
          : await execTransfer(target, guarded, signal, transport === 'exec-base64')
      return { ...result, transport }
    } catch (error) {
      if (!(error instanceof AttachmentError) || error.code !== 'UNSUPPORTED' || payloadStarted || transport === 'pty-base64') throw error
    }
  }
  throw new AttachmentError('UNSUPPORTED', 'No attachment transport is available')
}
