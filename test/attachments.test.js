const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const syncFs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const { spawn } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const { Subject, BehaviorSubject } = require('rxjs')
const ts = require('typescript')
const load = Module._load, extension = require.extensions['.ts']
Module._load = function (request, ...args) {
  if (request === '@angular/core') return { Injectable: () => value => value }
  if (request === 'tabby-core') return {}
  return load.call(this, request, ...args)
}
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(syncFs.readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, experimentalDecorators: true },
}).outputText, file)
const { AttachmentStore, AttachmentTabProgress, sha256, AttachmentError } = require('../src/attachments.ts')
const { sftpTransfer, execTransfer, execStream } = require('../src/attachment-transport.ts')
const { AttachmentTransferService } = require('../src/attachment-transfer.service.ts')
const { runAttachmentPty, ptyTransfer } = require('../src/attachment-pty.ts')
const { retainAttachmentChannel } = require('../src/attachment-channel.ts')
Module._load = load; require.extensions['.ts'] = extension

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tabby-attachments-'))
  t.after(() => fs.rm(root, { force: true, recursive: true }))
  return root
}
function target(sftp) {
  const native = new BehaviorSubject(null), session = { open: true, output$: new Subject(), closed$: new Subject() }
  let alive = true, refs = 0
  const tab = { sessionChanged$: new Subject(), destroyed$: new Subject(), progress$: native, setProgress: value => native.next(value) }
  return { tabId: 'ssh-one', title: 'SSH fixture', tab, session, valid: () => alive, disconnect: () => { alive = false; session.closed$.next() },
    ssh: { open: true, openSFTP: sftp ? async () => sftp : undefined, ref: () => refs++, unref: () => refs-- }, refs: () => refs }
}
function localRemote(root, remote) { return root && remote.startsWith('/fixture/') ? path.join(root, ...remote.slice('/fixture/'.length).split('/')) : root && remote === '/fixture' ? root : remote }
function localSftp(root) {
  const local = file => localRemote(root, file)
  return {
    mkdir: p => fs.mkdir(local(p)), chmod: (p, mode) => fs.chmod(local(p), mode), rename: (a, b) => fs.rename(local(a), local(b)), unlink: p => fs.unlink(local(p)), rmdir: p => fs.rmdir(local(p)),
    stat: async p => { const s = await fs.lstat(local(p)); return { size: s.size, modified: s.mtime, isDirectory: s.isDirectory(), isSymlink: s.isSymbolicLink() } },
    open: async (p, flags) => {
      const handle = await fs.open(local(p), flags === 1 ? 'r' : 'wx', 0o600)
      let closed = false
      return {
        read: async () => { const bytes = Buffer.alloc(8192); const result = await handle.read(bytes, 0, bytes.length, null); return bytes.subarray(0, result.bytesRead) },
        write: async bytes => { await handle.write(bytes) },
        close: async () => { if (!closed) { closed = true; await handle.close() } },
      }
    },
  }
}
function execTarget() {
  const result = target()
  result.ssh.ssh = {
    openSessionChannel: async () => ({}), activateChannel: async () => {
      const data$ = new Subject(), extendedData$ = new Subject(), closed$ = new Subject()
      let child
      return { data$, extendedData$, closed$,
        requestExec: async command => {
          child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] })
          child.stdout.on('data', value => data$.next(value))
          child.stderr.on('data', value => extendedData$.next([1, value]))
          child.on('close', () => closed$.next())
          child.stdin.on('error', () => {})
        },
        write: bytes => new Promise((resolve, reject) => child.stdin.write(bytes, error => error ? reject(error) : resolve())),
        eof: async () => child.stdin.end(), close: async () => { if (child?.exitCode === null) child.kill() },
      }
    },
  }
  return result
}
const posix = process.platform !== 'win32'
const signal = () => new AbortController().signal

test('native buffer retention affects only owned channel IDs and restores each hook', () => {
  const closed = [], original = id => closed.push(id), buffer = { closeChannel: original }, client = { events: { data$: buffer } }
  const releaseOne = retainAttachmentChannel(client, { id: 1 }), releaseTwo = retainAttachmentChannel(client, { id: 2 })
  buffer.closeChannel(1); buffer.closeChannel(3)
  assert.deepEqual(closed, [3])
  releaseOne(); assert.deepEqual(closed, [3, 1]); assert.notEqual(buffer.closeChannel, original)
  buffer.closeChannel(2); releaseTwo(); releaseTwo()
  assert.deepEqual(closed, [3, 1, 2]); assert.equal(buffer.closeChannel, original)
})

test('attachment cache is immutable, owner scoped, and paths are not model controlled', async t => {
  const root = await temporary(t), store = new AttachmentStore(root), source = Buffer.from('original')
  const item = await store.stage('one', '../file.txt', 'text/plain', source)
  source.fill(0)
  assert.equal(item.name, 'file.txt')
  assert.equal((await fs.readFile(store.file(item.id))).toString(), 'original')
  assert.throws(() => store.get('two', item.id), /unavailable/)
  assert.throws(() => store.file('../outside'), /Invalid/)
  assert.equal(store.list('two').length, 0)
  assert.equal(new AttachmentStore(root).get('one', item.id).sha256, item.sha256, 'metadata survives restart without replaying transfers')
  assert.deepEqual(Object.keys(item).sort(), ['createdAt','id','mime','name','owner','sha256','size'].sort())
})

test('SFTP upload and download stream beyond screen limits and verify every byte', async t => {
  const root = await temporary(t), bytes = randomBytes(1024 * 1024 + 17), source = async function* () { for (let i = 0; i < bytes.length; i += 49152) yield bytes.subarray(i, i + 49152) }
  const remotePath = '/fixture/private/file.bin', dest = target(localSftp(root))
  let progress = 0, checks = 0
  const result = await sftpTransfer(dest, { direction: 'upload', remotePath, source, size: bytes.length, hash: sha256(bytes), progress: n => { progress = n }, verifying: () => checks++ }, signal())
  assert.equal(result.hash, sha256(bytes)); assert.equal(progress, bytes.length); assert.equal(checks, 1)
  const read = []
  const downloaded = await sftpTransfer(dest, { direction: 'download', remotePath, sink: async b => read.push(b), progress() {}, verifying() {} }, signal())
  assert.equal(downloaded.hash, result.hash); assert.deepEqual(Buffer.concat(read), bytes)
  await assert.rejects(sftpTransfer(dest, { direction: 'upload', remotePath, source, size: bytes.length, hash: result.hash, progress() {}, verifying() {} }, signal()), /EEXIST/)
})

test('SFTP rejects changing source files and a failed verification does not publish', async t => {
  const root = await temporary(t), file = path.join(root, 'source'), original = Buffer.from('before')
  await fs.writeFile(file, original)
  const targetFile = target(localSftp(root))
  await assert.rejects(sftpTransfer(targetFile, { direction: 'download', remotePath: '/fixture/source', sink: async () => {}, progress() {}, verifying: () => syncFs.writeFileSync(file, 'change') }, signal()), /changed/)
  const remotePath = '/fixture/bad/file'
  await assert.rejects(sftpTransfer(targetFile, { direction: 'upload', remotePath, source: async function* () { yield original }, size: original.length, hash: '0'.repeat(64), progress() {}, verifying() {} }, signal()), /SHA-256/)
  await assert.rejects(fs.stat(localRemote(root, remotePath)), /ENOENT/)
})

for (const encoded of [false, true]) test(`real POSIX exec ${encoded ? 'base64' : 'binary'} upload/download round trip`, { skip: !posix }, async t => {
  const root = await temporary(t), bytes = randomBytes(128 * 1024 + 19), remotePath = path.join(root, encoded ? 'encoded' : 'binary', 'payload.bin')
  const dest = execTarget(), source = async function* () { for (let i = 0; i < bytes.length; i += 49152) yield bytes.subarray(i, i + 49152) }
  const uploaded = await execTransfer(dest, { direction: 'upload', remotePath, size: bytes.length, hash: sha256(bytes), source, progress() {}, verifying() {} }, signal(), encoded)
  assert.equal(uploaded.hash, sha256(bytes)); assert.deepEqual(await fs.readFile(remotePath), bytes)
  const chunks = []
  const downloaded = await execTransfer(dest, { direction: 'download', remotePath, sink: async chunk => chunks.push(chunk), progress() {}, verifying() {} }, signal(), encoded)
  assert.equal(downloaded.hash, uploaded.hash); assert.deepEqual(Buffer.concat(chunks), bytes)
})

test('native tab progress is weighted, capped during verification and yields to other producers', async () => {
  const subject = new BehaviorSubject(null), updates = [], tab = { progress$: subject, setProgress: n => { updates.push(n); subject.next(n) } }
  const progress = new AttachmentTabProgress(tab)
  progress.update('one', 50, 100); progress.update('two', 150, 300)
  await new Promise(resolve => setTimeout(resolve, 130))
  assert.equal(updates.at(-1), 50)
  progress.update('one', 100, 100, true); progress.update('two', 300, 300, true)
  await new Promise(resolve => setTimeout(resolve, 130))
  assert.equal(updates.at(-1), 99)
  subject.next(0.2)
  const count = updates.length
  progress.finish('one'); progress.finish('two')
  assert.equal(updates.length, count, 'must not erase another native transfer')
})

test('single service operation handles all chunks, deduplicates requests and only returns metadata', async t => {
  const root = await temporary(t), service = new AttachmentTransferService({ getConfigPath: () => path.join(root, 'config.yaml') })
  t.after(() => service.ngOnDestroy())
  const bytes = randomBytes(1024 * 1024), staged = await service.stage('owner', 'example.bin', '', bytes), dest = target(localSftp(root))
  const args = { attachmentId: staged.id, remotePath: '/fixture', requestId: 'one_request' }
  const one = service.start('owner', dest, 'upload', args), same = service.start('owner', dest, 'upload', args)
  assert.equal(one.operationId, same.operationId)
  assert.throws(() => service.start('owner', dest, 'upload', { ...args, remotePath: '/elsewhere' }), /different/)
  assert.throws(() => service.status('other', one.operationId), /unavailable/)
  const result = await service.wait('owner', one.operationId, 10000)
  assert.equal(result.status, 'completed', result.error)
  assert.equal(result.receipt.sha256, sha256(bytes)); assert.equal(result.bytesTransferred, bytes.length)
  assert.equal(dest.refs(), 0)
  assert.ok(JSON.stringify(result).length < 2000)
  const down = service.start('owner', dest, 'download', { remotePath: result.receipt.remotePath, requestId: 'down' })
  const received = await service.wait('owner', down.operationId, 10000)
  assert.equal(received.status, 'completed', received.error)
  assert.equal(service.list('owner').find(item => item.id === received.receipt.attachmentId).sha256, sha256(bytes))
  const restored = new AttachmentTransferService({ getConfigPath: () => path.join(root, 'config.yaml') })
  assert.equal(restored.status('owner', one.operationId).status, 'completed')
  assert.equal(restored.list('owner').length, 2)
  restored.ngOnDestroy()
})

test('unsupported SFTP falls back to exec without model chunk calls; permission failure does not', { skip: !posix }, async t => {
  const root = await temporary(t), service = new AttachmentTransferService({ getConfigPath: () => path.join(root, 'config.yaml') })
  t.after(() => service.ngOnDestroy())
  const staged = await service.stage('owner', 'payload', '', randomBytes(70000)), dest = execTarget()
  dest.ssh.openSFTP = async () => { throw new Error('SFTP subsystem request failed') }
  const op = service.start('owner', dest, 'upload', { attachmentId: staged.id, remotePath: root, requestId: 'fallback' })
  const result = await service.wait('owner', op.operationId, 10000)
  assert.equal(result.status, 'completed', result.error); assert.equal(result.transport, 'exec-binary')
  const deniedTarget = execTarget()
  deniedTarget.ssh.openSFTP = async () => { throw new Error('Permission denied') }
  const denied = service.start('owner', deniedTarget, 'upload', { attachmentId: staged.id, remotePath: root, requestId: 'denied' })
  const deniedResult = await service.wait('owner', denied.operationId, 10000)
  assert.equal(deniedResult.status, 'failed'); assert.equal(deniedResult.transport, 'sftp')
})

test('PTY fallback refuses an Agent/unknown shell without injecting input', async () => {
  const dest = target()
  await assert.rejects(ptyTransfer(dest, { direction: 'upload', remotePath: '/tmp/file', progress() {}, verifying() {} }, signal()), /verified idle shell/)
})

test('cancelling a pending SFTP open settles without starting another transport', async t => {
  const root = await temporary(t), service = new AttachmentTransferService({ getConfigPath: () => path.join(root, 'config.yaml') })
  t.after(() => service.ngOnDestroy())
  const file = await service.stage('owner', 'test', '', Buffer.from('data')), dest = target()
  dest.ssh.openSFTP = () => new Promise(() => {})
  const operation = service.start('owner', dest, 'upload', { attachmentId: file.id, remotePath: '/fixture', requestId: 'cancel-pending' })
  await new Promise(resolve => setTimeout(resolve, 10))
  service.cancel('owner', operation.operationId)
  const result = await service.wait('owner', operation.operationId, 1000)
  assert.equal(result.status, 'unknown'); assert.equal(result.transport, 'sftp'); assert.equal(dest.refs(), 0)
})

test('an unconfirmed SFTP publish remains unknown and preserves the unique path', async t => {
  const root = await temporary(t), sftp = localSftp(root), service = new AttachmentTransferService({ getConfigPath: () => path.join(root, 'config.yaml') })
  t.after(() => service.ngOnDestroy())
  const file = await service.stage('owner', 'test', '', Buffer.from('published'))
  const rename = sftp.rename
  sftp.rename = async (...args) => { await rename(...args); throw new Error('Connection lost after rename') }
  const operation = service.start('owner', target(sftp), 'upload', { attachmentId: file.id, remotePath: '/fixture', requestId: 'unknown-publish' })
  const result = await service.wait('owner', operation.operationId, 1000)
  assert.equal(result.status, 'unknown'); assert.equal(result.transport, 'sftp')
  assert.equal((await fs.readFile(localRemote(root, result.remotePath))).toString(), 'published')
  assert.equal(service.start('owner', target(sftp), 'upload', { attachmentId: file.id, remotePath: '/fixture', requestId: 'unknown-publish' }).operationId, operation.operationId)
})

test('real Linux PTY base64 upload/download preserves all bytes without model reads', { skip: process.platform !== 'linux', timeout: 20000 }, async t => {
  const root = await temporary(t), bytes = randomBytes(80000), dest = target()
  const controller = new AbortController()
  let transcript = ''
  const child = spawn('script', ['-qefc', 'stty rows 24 cols 100; exec /bin/sh -i', '/dev/null'], { detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TERM: 'xterm-256color', PS1: 'ATTACHMENT_PROMPT> ' } })
  child.stdin.on('error', () => {})
  child.stdout.on('data', value => { transcript = (transcript + value.toString()).slice(-4096); dest.session.output$.next(value.toString()) })
  child.stderr.on('data', () => {})
  t.after(async () => { controller.abort(); try { process.kill(-child.pid, 'SIGKILL') } catch {} })
  await new Promise(resolve => setTimeout(resolve, 100))
  dest.pty = (script, signal, sink, input) => runAttachmentPty(dest, script, signal, text => child.stdin.write(text), sink, input)
  const remotePath = path.join(root, 'pty', 'image.bin')
  const source = async function* () { for (let i = 0; i < bytes.length; i += 49152) yield bytes.subarray(i, i + 49152) }
  const timeout = setTimeout(() => controller.abort(), 10000)
  t.after(() => clearTimeout(timeout))
  const uploaded = await ptyTransfer(dest, { direction: 'upload', remotePath, size: bytes.length, hash: sha256(bytes), source, progress() {}, verifying() {} }, controller.signal)
  assert.equal(uploaded.hash, sha256(bytes))
  assert.deepEqual(await fs.readFile(remotePath), bytes)
  const chunks = []
  const downloaded = await ptyTransfer(dest, { direction: 'download', remotePath, sink: async chunk => chunks.push(chunk), progress() {}, verifying() {} }, signal())
  assert.equal(downloaded.hash, uploaded.hash); assert.deepEqual(Buffer.concat(chunks), bytes)
})


test('cached image previews survive service restart and enforce conversation ownership', async t => {
  const root = await temporary(t)
  const platform = { getConfigPath: () => path.join(root, 'config.yaml') }
  const service = new AttachmentTransferService(platform)
  const image = await service.stage('thread', 'shot.webp', 'image/webp', Buffer.from('image fixture'))
  const restored = new AttachmentTransferService(platform)
  assert.equal(await restored.preview('thread', image.id), 'data:image/webp;base64,' + Buffer.from('image fixture').toString('base64'))
  await assert.rejects(restored.preview('another-thread', image.id), /unavailable/)
  const text = await service.stage('thread', 'log.txt', 'text/plain', Buffer.from('log'))
  assert.equal(await service.preview('thread', text.id), undefined)
})
