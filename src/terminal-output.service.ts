import { Injectable } from '@angular/core'
import { AppService, SplitTabComponent } from 'tabby-core'
import { BaseTerminalTabComponent, BaseSession } from 'tabby-terminal'
import { Subject, Subscription } from 'rxjs'
import { IncrementalOutputBuffer, OutputSlice } from './output-buffer'

function cleanOutput (chunk: string): string {
  return chunk
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/\r(?!\n)/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}

interface WatchedTerminal {
  users: number
  buffer: IncrementalOutputBuffer
  sessionSubscription?: Subscription
  changeSubscription: Subscription
  session?: BaseSession | null
}

/** Subscribes only to terminals explicitly bound to an AI tab. */
@Injectable()
export class CodexTerminalOutputService {
  readonly updates$ = new Subject<BaseTerminalTabComponent<any>>()
  private watched = new Map<BaseTerminalTabComponent<any>, WatchedTerminal>()
  private suppressed = new Map<BaseTerminalTabComponent<any>, number>()
  private privateViews = new WeakMap<BaseTerminalTabComponent<any>, { session: any; marker: string; seen: boolean; completed: boolean; cursor: number }>()

  hideAttachmentOutput (terminal: BaseTerminalTabComponent<any>, marker: string): void {
    this.privateViews.set(terminal, { session: terminal.session, marker, seen: false, completed: false, cursor: this.cursor(terminal) })
  }
  sanitizeView (terminal: BaseTerminalTabComponent<any>, text: string): string {
    const view = this.privateViews.get(terminal)
    if (!view || view.session !== terminal.session) return text
    // xterm may wrap the fixed ASCII marker at narrow terminal widths.
    const pattern = view.marker.split('').map(char => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*') + '\\s*:\\s*\\d+'
    const match = new RegExp(pattern).exec(text)
    if (match) { view.seen = true; return '[Attachment payload omitted]\n' + text.slice(match.index + match[0].length) }
    if (view.seen) return text
    // If the footer aged out before the first read, use only post-capture output.
    if (view.completed) return this.readSince(terminal, view.cursor, 20000).text || '[Attachment payload omitted; waiting for fresh terminal output.]'
    return '[Attachment transfer output omitted; use attachment_status for its result.]'
  }

  isSuppressed (terminal: BaseTerminalTabComponent<any>): boolean { return !!this.suppressed.get(terminal) }
  suppress (terminal: BaseTerminalTabComponent<any>): () => void {
    const session = terminal.session
    let released = false
    this.suppressed.set(terminal, (this.suppressed.get(terminal) || 0) + 1)
    return () => {
      if (released || terminal.session !== session) return
      released = true
      const remaining = (this.suppressed.get(terminal) || 1) - 1
      if (remaining) this.suppressed.set(terminal, remaining); else this.suppressed.delete(terminal)
      const view = this.privateViews.get(terminal)
      if (!remaining && view?.session === session) { view.completed = true; view.cursor = this.cursor(terminal) }
    }
  }
  holdUntilShellPrompt (terminal: BaseTerminalTabComponent<any>, release: () => void): void {
    const session = terminal.session, subscriptions = new Subscription()
    let ended = false, pending = ''
    const finish = () => { release(); subscriptions.unsubscribe() }
    subscriptions.add(session?.output$?.subscribe(chunk => {
      pending = (pending + chunk).slice(-1024)
      const marks = /\x1b\]133;([AD])(?:;[^\x07\x1b]*)?(?:\x07|\x1b\\)/g
      let match: RegExpExecArray | null, consumed = 0
      while ((match = marks.exec(pending))) { consumed = marks.lastIndex; if (match[1] === 'D') ended = true; else if (ended) { finish(); return } }
      if (consumed) pending = pending.slice(consumed)
    }))
    subscriptions.add(terminal.sessionChanged$.subscribe(next => { if (next !== session) finish() }))
    // A close event can precede late native output. Keep the mask until the
    // next session (or unwatch), instead of accepting those late bytes.
    subscriptions.add(session?.closed$?.subscribe(() => subscriptions.unsubscribe()))
  }

  constructor (private app: AppService) {}

  watch (terminal: BaseTerminalTabComponent<any>): number {
    const existing = this.watched.get(terminal)
    if (existing) {
      existing.users++
      return existing.buffer.cursor
    }
    const state: WatchedTerminal = {
      users: 1,
      buffer: new IncrementalOutputBuffer(),
      changeSubscription: new Subscription(),
    }
    const attachSession = (session: BaseSession | null) => {
      if (state.session !== session) { this.suppressed.delete(terminal); this.privateViews.delete(terminal) }
      state.session = session
      state.sessionSubscription?.unsubscribe()
      state.sessionSubscription = session?.output$.subscribe(chunk => {
        if (this.isSuppressed(terminal)) return
        const text = cleanOutput(chunk)
        if (text) {
          state.buffer.append(text)
          this.updates$.next(terminal)
        }
      })
    }
    this.watched.set(terminal, state)
    state.changeSubscription = terminal.sessionChanged$.subscribe(attachSession)
    attachSession(terminal.session)
    return state.buffer.cursor
  }

  unwatch (terminal: BaseTerminalTabComponent<any>): void {
    const state = this.watched.get(terminal)
    if (!state || --state.users > 0) return
    state.changeSubscription.unsubscribe()
    state.sessionSubscription?.unsubscribe()
    this.watched.delete(terminal)
    this.suppressed.delete(terminal)
    this.privateViews.delete(terminal)
  }

  cursor (terminal: BaseTerminalTabComponent<any>): number {
    return this.watched.get(terminal)?.buffer.cursor ?? 0
  }

  has (terminal: BaseTerminalTabComponent<any>): boolean {
    return this.watched.has(terminal)
  }

  readSince (terminal: BaseTerminalTabComponent<any>, cursor: number, maxChars: number): OutputSlice {
    return this.watched.get(terminal)?.buffer.readSince(cursor, maxChars) ?? { text: '', cursor, truncated: false, hasMore: false }
  }

  /** Recovery may bind by cwd only when there is exactly one matching terminal. */
  async findSource (cwd: string): Promise<BaseTerminalTabComponent<any> | undefined> {
    const candidates = this.app.tabs.flatMap(tab => tab instanceof SplitTabComponent ? tab.getAllTabs() : [tab])
      .filter((tab): tab is BaseTerminalTabComponent<any> => tab instanceof BaseTerminalTabComponent)
    const matches: BaseTerminalTabComponent<any>[] = []
    for (const tab of candidates) {
      try {
        const current = await tab.session?.getWorkingDirectory()
        if (current === cwd) matches.push(tab)
      } catch { /* A session can close during the lookup. */ }
    }
    return matches.length === 1 ? matches[0] : undefined
  }
}
