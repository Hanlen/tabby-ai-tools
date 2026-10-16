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
      this.tail = this.tail.slice(dropped)
      this.start += dropped
    }
  }

  readSince (cursor: number, maxChars: number): OutputSlice {
    const truncated = cursor < this.start
    const offset = Math.max(this.start, Math.min(cursor, this.end)) - this.start
    const text = this.tail.slice(offset, offset + Math.max(0, maxChars))
    const nextCursor = this.start + offset + text.length
    return { text, cursor: nextCursor, truncated, hasMore: nextCursor < this.end }
  }
}
