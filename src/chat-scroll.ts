const BOTTOM_TOLERANCE = 2

/** Keep streaming output in view until the reader deliberately scrolls back. */
export class ChatScroll {
  private following = true
  private frame: number | null = null
  private lastTop = 0
  private touchY: number | undefined
  private showingJump = false
  private readonly resize: ResizeObserver
  private readonly mutations: MutationObserver

  constructor (private feed: HTMLElement, content: HTMLElement, private showJump: (visible: boolean) => void) {
    this.lastTop = feed.scrollTop
    this.resize = new ResizeObserver(this.schedule)
    this.resize.observe(feed)
    this.resize.observe(content)
    this.mutations = new MutationObserver(this.schedule)
    this.mutations.observe(content, { childList: true, subtree: true, characterData: true })
    feed.addEventListener('scroll', this.onScroll, { passive: true })
    feed.addEventListener('wheel', this.onWheel, { passive: true })
    feed.addEventListener('touchstart', this.onTouchStart, { passive: true })
    feed.addEventListener('touchmove', this.onTouchMove, { passive: true })
    feed.addEventListener('keydown', this.onKeydown)
    this.schedule()
  }

  jumpToLatest (): void {
    this.following = true
    this.updateJump()
    this.schedule()
  }

  destroy (): void {
    this.resize.disconnect()
    this.mutations.disconnect()
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.feed.removeEventListener('scroll', this.onScroll)
    this.feed.removeEventListener('wheel', this.onWheel)
    this.feed.removeEventListener('touchstart', this.onTouchStart)
    this.feed.removeEventListener('touchmove', this.onTouchMove)
    this.feed.removeEventListener('keydown', this.onKeydown)
  }

  private atBottom (): boolean {
    return this.feed.scrollHeight - this.feed.clientHeight - this.feed.scrollTop <= BOTTOM_TOLERANCE
  }

  private updateJump (): void {
    const visible = !this.following && !this.atBottom()
    if (visible === this.showingJump) return
    this.showingJump = visible
    this.showJump(visible)
  }

  private pause (): void {
    if (this.feed.scrollHeight <= this.feed.clientHeight) return
    this.following = false
    this.updateJump()
  }

  private readonly schedule = (): void => {
    if (this.frame !== null) return
    this.frame = requestAnimationFrame(() => {
      this.frame = null
      // Check at execution time: an upward gesture can cancel an already queued follow.
      if (this.following) this.feed.scrollTop = this.feed.scrollHeight
      else if (this.atBottom()) this.following = true
      this.lastTop = this.feed.scrollTop
      this.updateJump()
    })
  }

  private readonly onScroll = (): void => {
    // With scroll anchoring disabled, layout can only clamp upward to the new bottom.
    // Detect scrollbar dragging even if a streaming update changes the height at the same time.
    if (this.feed.scrollTop < this.lastTop && !this.atBottom()) this.following = false
    if (this.atBottom()) this.following = true
    this.lastTop = this.feed.scrollTop
    this.updateJump()
  }

  private readonly onWheel = (event: WheelEvent): void => {
    if (event.deltaY < 0 && !event.ctrlKey) this.pause()
  }

  private readonly onTouchStart = (event: TouchEvent): void => {
    this.touchY = event.touches[0]?.clientY
  }

  private readonly onTouchMove = (event: TouchEvent): void => {
    const y = event.touches[0]?.clientY
    if (y !== undefined && this.touchY !== undefined && y > this.touchY) this.pause()
    this.touchY = y
  }

  private readonly onKeydown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
    const target = event.target as HTMLElement | null
    if (target?.closest('input, textarea, select, button, a, [contenteditable="true"]')) return
    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) this.pause()
  }
}
