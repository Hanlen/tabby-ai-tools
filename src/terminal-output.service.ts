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
}

/** Subscribes only to terminals explicitly bound to an AI tab. */
@Injectable()
export class CodexTerminalOutputService {
  readonly updates$ = new Subject<BaseTerminalTabComponent<any>>()
  private watched = new Map<BaseTerminalTabComponent<any>, WatchedTerminal>()

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
      state.sessionSubscription?.unsubscribe()
      state.sessionSubscription = session?.output$.subscribe(chunk => {
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
