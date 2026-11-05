const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const ts = require('typescript')
const load = Module._load, extension = require.extensions['.ts']
Module._load = function (request, ...args) {
  if (request === '@angular/core') return { Component: () => value => value, Input: () => () => {}, Output: () => () => {}, ViewChild: () => () => {}, EventEmitter: class {} }
  if (['tabby-core', 'tabby-terminal', './codex.service', './terminal-output.service', './tab-tools', './agent-backend.service'].includes(request)) return {}
  if (request.endsWith('.pug') || request.endsWith('.css')) return ''
  return load.call(this, request, ...args)
}
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, experimentalDecorators: true },
}).outputText, file)
const { CodexPanelComponent } = require('../src/codex-panel.component.ts')
Module._load = load; require.extensions['.ts'] = extension
const image = { id: 'image', name: 'clipboard.png', mime: 'image/png', size: 100 }
const flush = () => new Promise(resolve => setImmediate(resolve))
function panel(service) {
  const p = new CodexPanelComponent({}, {}, { run: fn => fn() }, {}, {}, undefined, { detectChanges() {} }, service)
  p.threadId = 'one'
  const dialog = { open: false, showModal() { this.open = true }, close() { this.open = false } }
  p.attachmentPreviewDialog = { nativeElement: dialog }
  return p
}

test('clipboard images are staged while ordinary text keeps native paste behavior', async () => {
  const p = panel({}), staged = []
  p.addAttachmentFiles = async files => staged.push(...files)
  let prevented = 0, stopped = 0
  const paste = items => p.onAttachmentPaste({ clipboardData: { items }, preventDefault: () => prevented++, stopPropagation: () => stopped++ })
  paste([{ kind: 'string', type: 'text/plain' }])
  assert.equal(prevented, 0)
  paste([{ kind: 'file', getAsFile: () => image }, { kind: 'file', getAsFile: () => null }])
  assert.deepEqual(staged, [image])
  assert.equal(prevented, 1); assert.equal(stopped, 1)
})

test('only available image thumbnails open a modal and close clears the selected image', () => {
  const p = panel({})
  p.attachmentItems = [image]
  p.openAttachmentPreview(image)
  assert.equal(p.attachmentPreviewDialog.nativeElement.open, false)
  p.attachmentPreviews.set(image.id, 'data:image/png;base64,AA==')
  p.openAttachmentPreview(image)
  assert.equal(p.previewAttachment, image)
  assert.equal(p.attachmentPreviewDialog.nativeElement.open, true)
  p.closeAttachmentPreview()
  assert.equal(p.previewAttachment, undefined)
  assert.equal(p.attachmentPreviewDialog.nativeElement.open, false)
  p.openAttachmentPreview({ ...image, id: 'removed' })
  assert.equal(p.previewAttachment, undefined)
})

test('removing an attachment or switching conversations closes its preview and releases URLs', async () => {
  let items = [image]
  const p = panel({ list: owner => owner === 'one' ? items : [], remove: async () => { items = [] } })
  const url = URL.createObjectURL(new Blob(['image']))
  p.attachmentPreviews.set(image.id, url)
  p.refreshAttachments(); p.openAttachmentPreview(image)
  await p.removeAttachment(image.id)
  assert.equal(p.previewAttachment, undefined)
  assert.equal(p.attachmentPreviews.size, 0)
  await assert.rejects(fetch(url))
  items = [image]
  const secondUrl = URL.createObjectURL(new Blob(['image']))
  p.attachmentPreviews.set(image.id, secondUrl)
  p.refreshAttachments(); p.openAttachmentPreview(image)
  p.threadId = 'two'; p.refreshAttachments()
  assert.equal(p.previewAttachment, undefined)
  assert.equal(p.attachmentPreviewDialog.nativeElement.open, false)
  assert.equal(p.attachmentPreviews.size, 0)
  await assert.rejects(fetch(secondUrl))
})

test('delayed cached previews cannot repopulate a different conversation or overwrite a staged URL', async () => {
  let finish
  const p = panel({ list: owner => owner === 'one' ? [image] : [], preview: () => new Promise(resolve => { finish = resolve }) })
  p.refreshAttachments()
  p.threadId = 'two'; p.refreshAttachments()
  finish('data:image/png;base64,AA=='); await flush()
  assert.equal(p.attachmentPreviews.size, 0)
  p.threadId = 'one'; p.refreshAttachments()
  p.attachmentPreviews.set(image.id, 'blob:staged')
  finish('data:image/png;base64,AA=='); await flush()
  assert.equal(p.attachmentPreviews.get(image.id), 'blob:staged')
})

test('finishing an image paste after a conversation switch or panel destruction does not retain a URL', async t => {
  const OriginalImage = global.Image
  t.after(() => { if (OriginalImage === undefined) delete global.Image; else global.Image = OriginalImage })
  global.Image = class {
    naturalWidth = 100
    naturalHeight = 100
    set src(_value) { queueMicrotask(() => this.onload()) }
  }
  for (const destroyed of [false, true]) {
    let finish, started
    const staged = new Promise(resolve => { started = resolve })
    const p = panel({ list: () => [], stage: () => new Promise(resolve => { finish = resolve; started() }) })
    const file = new Blob(['image bytes'], { type: 'image/png' })
    const adding = p.addAttachmentFiles([file])
    await staged
    if (destroyed) {
      p.attachmentsDestroyed = true
      p.changeDetector.detectChanges = () => assert.fail('must not update a destroyed view')
    } else p.threadId = 'two'
    finish(image)
    await adding
    assert.equal(p.attachmentPreviews.size, 0)
    assert.equal(p.attachmentBusy, false)
  }
})
