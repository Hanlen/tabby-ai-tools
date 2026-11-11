import { failure, randomId } from './policy.cjs'

/** Every request settles locally, even when the parent channel throws or closes. */
export class UtilityRequests {
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; cleanup: () => void }>()
  private closed = false
  constructor (private send: (message: any) => void, private disconnected: () => void) {}
  get size (): number { return this.pending.size }
  post (message: any): boolean {
    if (this.closed) return false
    try { this.send(message); return true } catch { this.close(); return false }
  }
  close (): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.pending.values()) { waiter.cleanup(); waiter.reject(failure('cancelled')) }
    this.pending.clear(); this.disconnected()
  }
  receive (message: any): void {
    const waiter = this.pending.get(message?.id)
    if (!waiter) return
    this.pending.delete(message.id); waiter.cleanup()
    if (message.error) waiter.reject(failure(message.error)); else waiter.resolve(message.value)
  }
  invoke (clientId: string, revision: number, tool: string, args: any, signal: AbortSignal, timeoutMs = 33000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this.closed || signal.aborted) return reject(failure('cancelled'))
      if (this.pending.size >= 16) return reject(failure('busy'))
      const id = randomId()
      const finish = (code: string) => {
        if (!this.pending.delete(id)) return
        cleanup(); reject(failure(code))
        this.post({ type: 'cancel', id })
      }
      const abort = () => finish('cancelled')
      const timer = setTimeout(() => finish('observation_timeout'), timeoutMs)
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort) }
      this.pending.set(id, { resolve, reject, cleanup })
      signal.addEventListener('abort', abort, { once: true })
      this.post({ type: 'tool', id, clientId, revision, tool, args })
    })
  }
}
