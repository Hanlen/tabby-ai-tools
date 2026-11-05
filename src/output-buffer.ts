export interface OutputSlice {
  text: string
  cursor: number
  truncated: boolean
  hasMore: boolean
}

/** Keeps a bounded tail of a stream with stable, monotonically increasing cursors. */
export class IncrementalOutputBuffer {
  private tail = ''
  private start = 0
  private end = 0

  constructor (private readonly capacity = 32768) {}

  get cursor (): number { return this.end }

  append (chunk: string): void {
    if (!chunk) return
    this.tail += chunk
    this.end += chunk.length
    if (this.tail.length > this.capacity) {
      const dropped = this.tail.length - this.capacity
      const safeDrop = /[\udc00-\udfff]/.test(this.tail[dropped] || '') ? dropped + 1 : dropped
      this.tail = this.tail.slice(safeDrop)
      this.start += safeDrop
    }
  }

  trimTo (capacity: number): void {
    let dropped = Math.max(0, this.tail.length - capacity)
    if (/[\udc00-\udfff]/.test(this.tail[dropped] || '')) dropped++
    this.tail = this.tail.slice(dropped); this.start += dropped
  }

  get size (): number { return this.tail.length }

  readSince (cursor: number, maxChars: number): OutputSlice {
    const truncated = cursor < this.start
    let offset = Math.max(this.start, Math.min(cursor, this.end)) - this.start
    if (/[\udc00-\udfff]/.test(this.tail[offset] || '')) offset++
    let end = offset + Math.max(0, maxChars)
    if (end < this.tail.length && /[\udc00-\udfff]/.test(this.tail[end])) end--
    const text = this.tail.slice(offset, end)
    const nextCursor = this.start + offset + text.length
    return { text, cursor: nextCursor, truncated, hasMore: nextCursor < this.end }
  }
}
