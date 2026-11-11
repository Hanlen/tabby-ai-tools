import { AfterViewInit, Component, ElementRef, EventEmitter, Input, OnDestroy, Output } from '@angular/core'
import { ChatEntry } from './chat-activity'
import { translate } from './i18n'

import { outcomeLabel } from './agent-conversation-state'

let nextFeedId = 0

/** Backend-independent question index. Navigation never invokes a backend. */
@Component({
  selector: 'agent-conversation-navigation',
  template: `
    <nav [attr.aria-label]='t("问题目录")' [attr.title]='t("问题目录") + " · " + questions.length' (mouseleave)='preview = undefined' (keydown.escape)='preview = undefined' (wheel)='wheel($event)'>
      <div class='agent-scrollbar' *ngIf='scrollable' role='scrollbar' tabindex='0'
        [attr.aria-label]='t("对话消息")' aria-orientation='vertical' aria-valuemin='0' aria-valuemax='100'
        [attr.aria-valuenow]='scrollPercent' [attr.aria-controls]='feed.id'
        (pointerdown)='startDrag($event)' (pointermove)='drag($event)' (pointerup)='endDrag($event)' (pointercancel)='endDrag($event)'
        (lostpointercapture)='endDrag($event)'
        (keydown)='scrollKey($event)'>
        <span class='agent-scrollbar-thumb' [style.top.px]='thumbTop' [style.height.px]='thumbHeight'></span>
      </div>
      <div class='agent-navigation-body'>
      <button class='agent-navigation-step' type='button' *ngIf='overflow' [disabled]='!canUp'
        [attr.aria-label]='t("向上滚动问题目录")' (click)='scroll(-1)'>↑</button>
      <div class='agent-navigation-list' (keydown)='onKey($event)' (scroll)='measure()'>
        <div class='agent-navigation-items'>
        <button type='button' *ngFor='let entry of questions; let i = index; trackBy: track'
          [attr.data-navigation-id]='entry.id' [attr.tabindex]='i === selection ? 0 : -1'
          [attr.data-outcome]='entry.outcome || "unknown"'
          [attr.aria-current]='current === entry.id ? "location" : null'
          [attr.aria-label]='(i + 1) + ". " + entry.text + " · " + t(label(entry.outcome))'
          (mouseenter)='show(entry, $event)' (focus)='selection = i; show(entry, $event)'
          (blur)='preview = undefined' (click)='activate(entry, i)'>
          <span class='agent-navigation-line' aria-hidden='true'></span>
        </button>
        </div>
      </div>
      <button class='agent-navigation-step' type='button' *ngIf='overflow' [disabled]='!canDown'
        [attr.aria-label]='t("向下滚动问题目录")' (click)='scroll(1)'>↓</button>
      </div>
      <div class='agent-navigation-preview' *ngIf='preview' [style.top.px]='previewTop' role='tooltip'>
        <strong>{{t(label(preview.outcome))}}</strong>
        <div dir='auto'>{{preview.text.slice(0, 180)}}</div>
      </div>
    </nav>`,
  styles: [`
    :host{position:absolute;inset-block:0;right:0;width:18px;z-index:2}
    nav{height:100%;display:flex;flex-direction:column}
    .agent-scrollbar{position:absolute;inset:0;cursor:ns-resize;touch-action:none}
    .agent-scrollbar-thumb{position:absolute;right:0;width:4px;border-radius:3px;background:currentColor;opacity:.25}
    .agent-scrollbar:hover .agent-scrollbar-thumb,.agent-scrollbar:focus-visible .agent-scrollbar-thumb{opacity:.55}
    .agent-scrollbar:focus-visible{outline:1px solid currentColor;outline-offset:-1px}
    .agent-navigation-body{position:relative;pointer-events:none;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;flex:1;min-height:0}
    .agent-navigation-list{width:14px;min-height:0;overflow-y:auto;scrollbar-width:none;overscroll-behavior:contain;pointer-events:auto}
    .agent-navigation-list::-webkit-scrollbar{display:none}
    .agent-navigation-items{display:flex;flex-direction:column;align-items:center}
    button{display:flex;align-items:center;justify-content:center;flex-shrink:0;width:14px;height:16px;min-height:16px;border:0;border-radius:4px;background:transparent;color:inherit;cursor:pointer;padding:0;pointer-events:auto}
    button:hover{background:var(--theme-hover-bg,rgba(128,128,128,.16))}
    button:active{background:var(--theme-active-bg,rgba(128,128,128,.25))}
    .agent-navigation-step{height:24px;min-height:24px;font-size:16px}
    .agent-navigation-step:disabled{opacity:.3;cursor:default;background:transparent}
    button:focus-visible{outline:2px solid currentColor;outline-offset:-2px}
    .agent-navigation-line{height:1px;width:8px;border-radius:1px;background:currentColor}
    button[aria-current] .agent-navigation-line{width:12px;height:1px}
    button[data-outcome=unknown],button[data-outcome=failed]{color:var(--agent-result-unknown,#89929e)}
    button[data-outcome=complete]{color:var(--agent-result-success,#218838)}
    button[data-outcome=stopped],button[data-outcome=incomplete],button[data-outcome=limited]{color:var(--agent-result-error,#d83945)}
    button[data-outcome=interrupted]{color:var(--agent-result-interrupted,#6b9978)}
    button[data-outcome=blocked],button[data-outcome=running]{color:var(--agent-result-running,#3985df)}
    .agent-navigation-preview{position:absolute;right:20px;width:230px;max-width:calc(100vw - 50px);padding:10px;border:1px solid currentColor;border-radius:6px;background:var(--theme-bg,#222);color:var(--theme-fg,#eee);box-shadow:0 3px 12px #0004;overflow-wrap:anywhere;font-size:12px;max-height:160px;overflow:auto}
    @media(pointer:coarse){button{height:44px;min-height:44px}}
  `],
})
export class AgentConversationNavigationComponent implements AfterViewInit, OnDestroy {
  @Input() entries: ChatEntry[] = []
  @Input() feed!: HTMLElement
  @Output() navigate = new EventEmitter<ChatEntry>()
  readonly t = translate
  readonly label = outcomeLabel
  preview?: ChatEntry
  previewTop = 0
  selection = 0
  current = ''
  private navigationTarget?: { id: string; scrollTop: number }
  private frame = 0
  private observer?: MutationObserver
  private resizeObserver?: ResizeObserver
  overflow = false
  canUp = false
  canDown = false
  scrollable = false
  thumbTop = 0
  thumbHeight = 0
  scrollPercent = 0
  private dragging?: { pointerId: number; offset: number }
  private measureScrollbar (): void {
    const height = this.host.nativeElement.clientHeight
    const range = Math.max(0, this.feed.scrollHeight - this.feed.clientHeight)
    this.scrollable = range > 1
    this.thumbHeight = Math.min(height, Math.max(24, height * this.feed.clientHeight / Math.max(1, this.feed.scrollHeight)))
    this.scrollPercent = range ? Math.round(100 * this.feed.scrollTop / range) : 0
    this.thumbTop = range ? (height - this.thumbHeight) * this.feed.scrollTop / range : 0
  }
  startDrag (event: PointerEvent): void {
    if (!event.isPrimary || event.button !== 0) return
    event.preventDefault()
    this.preview = undefined
    const track = event.currentTarget as HTMLElement
    const y = event.clientY - track.getBoundingClientRect().top
    const offset = y >= this.thumbTop && y <= this.thumbTop + this.thumbHeight ? y - this.thumbTop : this.thumbHeight / 2
    this.dragging = { pointerId: event.pointerId, offset }
    track.setPointerCapture(event.pointerId)
    this.drag(event)
  }
  drag (event: PointerEvent): void {
    if (this.dragging?.pointerId !== event.pointerId) return
    const track = event.currentTarget as HTMLElement
    const travel = track.clientHeight - this.thumbHeight
    if (travel <= 0) return
    const position = (event.clientY - track.getBoundingClientRect().top - this.dragging.offset) / travel
    this.feed.scrollTop = Math.max(0, Math.min(1, position)) * (this.feed.scrollHeight - this.feed.clientHeight)
    this.measureScrollbar()
  }
  endDrag (event: PointerEvent): void {
    if (this.dragging?.pointerId !== event.pointerId) return
    this.dragging = undefined
    const track = event.currentTarget as HTMLElement
    if (track.hasPointerCapture(event.pointerId)) track.releasePointerCapture(event.pointerId)
  }
  scrollKey (event: KeyboardEvent): void {
    const delta: Record<string, number> = { ArrowUp: -40, ArrowDown: 40, PageUp: -this.feed.clientHeight, PageDown: this.feed.clientHeight, Home: -this.feed.scrollHeight, End: this.feed.scrollHeight }
    if (!(event.key in delta) || event.altKey || event.ctrlKey || event.metaKey) return
    event.preventDefault()
    this.feed.scrollTop += delta[event.key]
    this.measureScrollbar()
  }
  wheel (event: WheelEvent): void {
    if (event.ctrlKey || (event.target as HTMLElement).closest('.agent-navigation-list')) return
    event.preventDefault()
    // Let the shared feed controller pause streaming follow before moving up.
    this.feed.dispatchEvent(new WheelEvent('wheel', { deltaY: event.deltaY }))
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.feed.clientHeight : 1)
    this.feed.scrollTop += delta
  }
  private get list (): HTMLElement | null { return this.host.nativeElement.querySelector('.agent-navigation-list') }
  measure (): void {
    const list = this.list
    const body = this.host.nativeElement.querySelector<HTMLElement>('.agent-navigation-body')
    const items = this.host.nativeElement.querySelector<HTMLElement>('.agent-navigation-items')
    if (!list || !body || !items) return
    this.overflow = items.scrollHeight > body.clientHeight + 1
    this.canUp = list.scrollTop > 1
    this.canDown = list.scrollTop + list.clientHeight < list.scrollHeight - 1
  }
  scroll (direction: number): void {
    this.preview = undefined
    const list = this.list
    if (list) list.scrollBy({ top: direction * Math.max(16, list.clientHeight * .75), behavior: 'auto' })
  }
  constructor (private host: ElementRef<HTMLElement>) {}
  get questions (): ChatEntry[] { return this.entries.filter(entry => entry.kind === 'user') }
  track (_: number, entry: ChatEntry): string { return entry.id }
  activate (entry: ChatEntry, index: number): void {
    this.current = entry.id
    this.selection = index
    this.navigate.emit(entry)
    // Navigation may clamp at either end, or leave a short feed stationary.
    // Keep the chosen question until the feed actually moves again.
    this.navigationTarget = { id: entry.id, scrollTop: this.feed.scrollTop }
  }
  show (entry: ChatEntry, event: Event): void {
    this.preview = entry
    this.previewTop = Math.max(0, Math.min((event.currentTarget as HTMLElement).getBoundingClientRect().top - this.host.nativeElement.getBoundingClientRect().top, this.host.nativeElement.clientHeight - 180))
  }
  onKey (event: KeyboardEvent): void {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    const buttons = Array.from(this.host.nativeElement.querySelectorAll<HTMLButtonElement>('.agent-navigation-list button'))
    if (!buttons.length) return
    event.preventDefault()
    this.selection = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, this.selection + (event.key === 'ArrowUp' ? -1 : 1)))
    buttons[this.selection].focus()
  }
  private readonly update = (): void => {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      const top = this.feed.getBoundingClientRect().top + 13
      const nodes = Array.from(this.feed.querySelectorAll<HTMLElement>('[data-agent-question]'))
      const node = nodes.filter(x => x.getBoundingClientRect().top <= top).pop() || nodes[0]
      const previous = this.current
      const target = this.navigationTarget
      if (target && this.questions.some(entry => entry.id === target.id) && Math.abs(this.feed.scrollTop - target.scrollTop) < .5) {
        this.current = target.id
      } else {
        this.navigationTarget = undefined
        this.current = node?.getAttribute('data-agent-question') || ''
      }
      this.measure()
      this.measureScrollbar()
      if (this.current && previous !== this.current) {
        const button = Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>('[data-navigation-id]'))
          .find(element => element.getAttribute('data-navigation-id') === this.current)
        if (button && this.list) this.list.scrollTop += button.getBoundingClientRect().top - this.list.getBoundingClientRect().top - (this.list.clientHeight - button.clientHeight) / 2
      }
      this.selection = Math.min(this.selection, Math.max(0, this.questions.length - 1))
      if (this.preview && !this.entries.includes(this.preview)) this.preview = undefined
    })
  }
  ngAfterViewInit (): void {
    if (!this.feed.id) this.feed.id = `agent-conversation-feed-${++nextFeedId}`
    this.feed.addEventListener('scroll', this.update, { passive: true })
    this.observer = new MutationObserver(this.update)
    this.observer.observe(this.feed, { childList: true, subtree: true, characterData: true })
    this.resizeObserver = new ResizeObserver(this.update)
    this.resizeObserver.observe(this.host.nativeElement)
    this.resizeObserver.observe(this.feed)
    const content = this.feed.firstElementChild
    if (content) this.resizeObserver.observe(content)
    const items = this.host.nativeElement.querySelector('.agent-navigation-items')
    if (items) this.resizeObserver.observe(items)
    this.update()
  }
  ngOnDestroy (): void {
    this.feed.removeEventListener('scroll', this.update)
    this.observer?.disconnect()
    this.resizeObserver?.disconnect()
    if (this.frame) cancelAnimationFrame(this.frame)
  }
}
