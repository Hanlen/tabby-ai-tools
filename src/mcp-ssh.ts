import { createHash } from 'crypto'
import { constants } from 'fs'
import { link, lstat, mkdtemp, open, realpath, rm } from 'fs/promises'
import * as path from 'path'
import { ATTACHMENT_LIMIT, checkTransfer, safeRemotePath } from './attachments'
import { execStream, TransferTarget } from './attachment-transport'
import { transferAttachment } from './attachment-transfer'

export async function mcpSshExec (target: TransferTarget, command: string, signal: AbortSignal) {
  const chunks: Buffer[] = []
  let bytes = 0, truncated = false, exitCode: number | undefined, stderr = ''
  await execStream(target, command, signal, async chunk => {
    const remaining = 16_000 - bytes
    if (chunk.length > remaining) truncated = true
    if (remaining > 0) {
      const slice = chunk.subarray(0, remaining)
      chunks.push(slice); bytes += slice.length
    }
  }, undefined, false, (code, errors) => { exitCode = code; stderr = errors })
  return { exitCode, stdout: Buffer.concat(chunks).toString('utf8'), stderr, stdoutTruncated: truncated }
}

export async function mcpSftpTransfer (target: TransferTarget, args: { direction: 'upload' | 'download'; localPath: string; remotePath: string }, signal: AbortSignal) {
  const requested = args.localPath
  if (!path.isAbsolute(requested) || /[\x00-\x1f\x7f]/.test(requested)) throw new Error('An absolute local file path is required')
  const remote = safeRemotePath(args.remotePath)
  const local = path.join(await realpath(path.dirname(requested)), path.basename(requested))
  checkTransfer(signal)
  const hooks = { progress: () => undefined, verifying: () => undefined }
  if (args.direction === 'upload') {
    const before = await lstat(local)
    if (!before.isFile()) throw new Error('Upload requires a regular local file')
    const file = await open(local, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0))
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > ATTACHMENT_LIMIT) throw new Error('Upload requires a regular local file up to 100 MiB')
      const source = async function * () {
        let offset = 0
        while (offset < stat.size) {
          checkTransfer(signal)
          const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, stat.size - offset))
          const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
          if (!bytesRead) throw new Error('Local file changed during transfer')
          offset += bytesRead
          yield buffer.subarray(0, bytesRead)
        }
      }
      const hash = createHash('sha256')
      for await (const chunk of source()) hash.update(chunk)
      const result = await transferAttachment(target, { ...hooks, direction: 'upload', remotePath: remote, size: stat.size, hash: hash.digest('hex'), source }, signal)
      return { ...result, remotePath: remote }
    } finally { await file.close() }
  }

  const staging = await mkdtemp(path.join(path.dirname(local), '.tabby-mcp-'))
  try {
    const temporary = path.join(staging, 'file')
    const file = await open(temporary, 'wx', 0o600)
    let result
    try {
      result = await transferAttachment(target, { ...hooks, direction: 'download', remotePath: remote, sink: async chunk => {
        await file.writeFile(chunk)
      } }, signal)
    } finally { await file.close() }
    checkTransfer(signal)
    if (!target.valid()) throw new Error('SSH connection changed before the verified file could be saved')
    await link(temporary, local)
    return { ...result, localPath: requested }
  } finally { await rm(staging, { force: true, recursive: true }) }
}
