/*!
 * Adapted from tabby-ai-workspace-manager's exec-event-buffers compatibility approach.
 * MIT License
 * Copyright (c) 2026 Julyan
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
/** russh native callbacks can deliver channel data after close. Hold only our
 * channel's event buffers until its random result frame has been consumed.
 * Compatibility approach informed by tabby-ai-workspace-manager (MIT).
 */
const retained = new WeakMap<object, { original: (id: number) => void; wrapper: (id: number) => void; ids: Map<number, { count: number; closed: boolean }> }>()
export function retainAttachmentChannel (client: any, channel: any): () => void {
  if (typeof channel?.id !== 'number' || !client?.events) return () => {}
  const releases: (() => void)[] = []
  for (const name of ['data$', 'extendedData$', 'eof$', 'close$']) {
    const buffer = client.events[name]
    if (typeof buffer?.closeChannel !== 'function') continue
    let guard = retained.get(buffer)
    if (!guard) {
      const original = buffer.closeChannel, ids = new Map<number, { count: number; closed: boolean }>()
      const wrapper = (id: number) => { const entry = ids.get(id); if (entry) entry.closed = true; else original.call(buffer, id) }
      guard = { original, wrapper, ids }; retained.set(buffer, guard); buffer.closeChannel = wrapper
    }
    const entry = guard.ids.get(channel.id) || { count: 0, closed: false }
    entry.count++; guard.ids.set(channel.id, entry)
    const held = guard
    releases.push(() => {
      if (--entry.count) return
      held.ids.delete(channel.id)
      if (entry.closed) held.original.call(buffer, channel.id)
      if (!held.ids.size) { if (buffer.closeChannel === held.wrapper) buffer.closeChannel = held.original; retained.delete(buffer) }
    })
  }
  let released = false
  return () => { if (!released) { released = true; releases.forEach(release => release()) } }
}
