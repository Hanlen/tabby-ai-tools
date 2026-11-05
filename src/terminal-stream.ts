import { createHmac, randomBytes, timingSafeEqual } from 'crypto'

/** Streaming control filter. Control payloads never become printable after overflow. */
export class TerminalTextFilter {
  private state: 'text' | 'esc' | 'csi' | 'string' | 'stringEsc' = 'text'
  private pendingHigh = ''
  private previousCR = false
  reset (): void { this.state = 'text'; this.pendingHigh = ''; this.previousCR = false }
  feed (chunk: string): string {
    let output = ''
    for (const char of this.pendingHigh + chunk) {
      if (this.state === 'string') { if (char === '\x07' || char === '\x9c') this.state = 'text'; else if (char === '\x1b') this.state = 'stringEsc'; continue }
      if (this.state === 'stringEsc') { this.state = char === '\\' ? 'text' : 'string'; continue }
      if (this.state === 'csi') { if (char >= '@' && char <= '~') this.state = 'text'; continue }
      if (this.state === 'esc') { this.state = char === '[' ? 'csi' : ']PX^_'.includes(char) ? 'string' : 'text'; continue }
      if (char === '\x1b') { this.state = 'esc'; continue }
      if (char === '\x9b') { this.state = 'csi'; continue }
      if ('\x90\x9d\x9e\x9f'.includes(char)) { this.state = 'string'; continue }
      if (char === '\n' && this.previousCR) { this.previousCR = false; continue }
      this.previousCR = char === '\r'
      if (char === '\r') output += '\n'
      else if (char === '\n' || char === '\t' || char >= ' ' && !(char >= '\x7f' && char <= '\x9f')) output += char
    }
    this.pendingHigh = ''
    if (output.length && /[\ud800-\udbff]/.test(output[output.length - 1])) { this.pendingHigh = output.slice(-1); output = output.slice(0, -1) }
    return output
  }
}

export class StreamTokens {
  private secret = randomBytes(32)
  encode (scope: string, stream: string, offset: number, revision?: number): string {
    const data = Buffer.from(JSON.stringify([scope, stream, offset, revision])).toString('base64url')
    return data + '.' + createHmac('sha256', this.secret).update(data).digest('hex')
  }
  inspect (token: string, scope: string): { stream: string; offset: number; revision?: number } {
    if (typeof token !== 'string' || token.length > 4096) throw new Error('Cursor unavailable')
    const parts = token.split('.')
    const [data, signature] = parts
    const expected = createHmac('sha256', this.secret).update(data || '').digest('hex')
    if (parts.length !== 2 || !/^[a-f0-9]{64}$/.test(signature || '') || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error('Cursor unavailable')
    const [owner, stream, offset, revision] = JSON.parse(Buffer.from(data, 'base64url').toString())
    if (owner !== scope || typeof stream !== 'string' || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Cursor unavailable')
    return { stream, offset, revision: Number.isSafeInteger(revision) ? revision : undefined }
  }
  decode (token: string, scope: string, stream: string): number {
    const value = this.inspect(token, scope)
    if (value.stream !== stream) throw new Error('cursor_session_changed: read the current terminal again')
    return value.offset
  }
}
