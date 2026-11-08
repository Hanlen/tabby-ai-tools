import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, Input, OnChanges, OnDestroy, Renderer2, ViewEncapsulation } from '@angular/core'
import { PlatformService } from 'tabby-core'
import { onLanguageChange, translate } from './i18n'
import { MarkdownBlock, markdownExternalUrl, renderMarkdown } from './markdown'

@Component({
  selector: 'codex-markdown',
  template: '<div class="codex-md-block" *ngFor="let block of blocks; trackBy: trackBlock" [innerHTML]="block.html"></div>',
  styles: [require('./markdown.component.css')],
  // innerHTML descendants do not receive Angular's emulated style attributes.
  // All rules are explicitly scoped to this component's host class instead.
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'codex-markdown', dir: 'auto', '(click)': 'onClick($event)', '(auxclick)': 'onLink($event)' },
})
export class MarkdownComponent implements OnChanges, OnDestroy {
  @Input() text = ''
  blocks: MarkdownBlock[] = []
  private frame: number | undefined
  private destroyed = false
  private copyTimer?: ReturnType<typeof setTimeout>
  private copiedButton?: HTMLButtonElement
  private readonly stopLanguageListener = onLanguageChange(() => this.schedule())

  constructor (
    private host: ElementRef<HTMLElement>,
    private renderer: Renderer2,
    private changes: ChangeDetectorRef,
    private platform: PlatformService,
  ) {}

  ngOnChanges (): void { this.schedule() }

  trackBlock (index: number): number { return index }

  private schedule (): void {
    if (this.destroyed || this.frame !== undefined) return
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined
      if (this.destroyed) return
      const host = this.host.nativeElement
      const positions = Array.from(host.querySelectorAll<HTMLElement>('.codex-md-table, pre')).map(node => node.scrollLeft)
      this.blocks = renderMarkdown(this.text, translate('表格'))
      this.changes.detectChanges()
      this.enhanceCodeBlocks()
      host.querySelectorAll<HTMLElement>('.codex-md-table, pre').forEach((node, index) => {
        if (positions[index]) node.scrollLeft = positions[index]
      })
    })
  }

  private enhanceCodeBlocks (): void {
    const host = this.host.nativeElement
    for (const pre of Array.from(host.querySelectorAll('pre'))) {
      if (pre.parentElement?.classList.contains('codex-md-code')) continue
      // Angular sanitizes all model HTML first. Add only our own fixed controls;
      // never compile or trust model-provided HTML or event bindings.
      const wrapper = this.renderer.createElement('div') as HTMLElement
      this.renderer.addClass(wrapper, 'codex-md-code')
      this.renderer.insertBefore(pre.parentNode, wrapper, pre)
      const heading = this.renderer.createElement('div') as HTMLElement
      this.renderer.addClass(heading, 'codex-md-code-heading')
      const language = Array.from(pre.querySelector('code')?.classList || []).find(name => name.startsWith('language-'))?.slice(9) || ''
      const label = this.renderer.createElement('span') as HTMLElement
      this.renderer.setProperty(label, 'textContent', language)
      this.renderer.setAttribute(label, 'title', language)
      this.renderer.appendChild(heading, label)
      const button = this.renderer.createElement('button') as HTMLButtonElement
      this.renderer.addClass(button, 'codex-md-copy')
      this.renderer.setAttribute(button, 'type', 'button')
      this.renderer.setAttribute(button, 'aria-live', 'polite')
      this.renderer.appendChild(heading, button)
      this.renderer.appendChild(wrapper, heading)
      this.renderer.appendChild(wrapper, pre)
      this.renderer.setAttribute(pre, 'tabindex', '0')
    }
    host.querySelectorAll<HTMLButtonElement>('.codex-md-copy').forEach(button => {
      if (button !== this.copiedButton) this.labelCopyButton(button)
    })
  }

  private labelCopyButton (button: HTMLButtonElement): void {
    this.renderer.setProperty(button, 'textContent', translate('复制'))
    this.renderer.setAttribute(button, 'aria-label', translate('复制代码'))
  }

  onClick (event: MouseEvent): void {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>('button.codex-md-copy')
    if (!button || !this.host.nativeElement.contains(button)) { this.onLink(event); return }
    event.preventDefault()
    const code = button.closest('.codex-md-code')?.querySelector('pre code')
    if (!code) return
    if (this.copyTimer) clearTimeout(this.copyTimer)
    if (this.copiedButton?.isConnected) this.labelCopyButton(this.copiedButton)
    this.copiedButton = button
    let label: string
    try {
      this.platform.setClipboard({ text: code.textContent || '' })
      label = translate('已复制')
    } catch { label = translate('复制失败') }
    this.renderer.setProperty(button, 'textContent', label)
    this.renderer.setAttribute(button, 'aria-label', label)
    this.copyTimer = setTimeout(() => {
      this.copyTimer = undefined
      this.copiedButton = undefined
      if (!this.destroyed && button.isConnected) this.labelCopyButton(button)
    }, 1600)
  }

  onLink (event: MouseEvent): void {
    const link = (event.target as Element | null)?.closest<HTMLAnchorElement>('a')
    if (!link || !this.host.nativeElement.contains(link)) return
    // Suppress navigation even for unsupported URLs and middle clicks.
    event.preventDefault()
    if (event.button !== 0 && event.button !== 1) return
    const href = markdownExternalUrl(link.getAttribute('href') || '')
    if (href) this.platform.openExternal(href)
  }

  ngOnDestroy (): void {
    this.destroyed = true
    if (this.frame !== undefined) cancelAnimationFrame(this.frame)
    if (this.copyTimer) clearTimeout(this.copyTimer)
    this.stopLanguageListener()
  }
}
