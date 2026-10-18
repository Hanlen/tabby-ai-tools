import { ApplicationRef, ComponentFactoryResolver, ComponentRef, Injectable, Injector, OnDestroy } from '@angular/core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { CodexPanelComponent } from './codex-panel.component'
import { clampSidebarWidth } from './sidebar-sizing'
import { findSidebarMount } from './sidebar-mount'

const WIDTH_KEY = 'tabbyCodexAgentSidebarWidth'

/** Mounts one reusable, resizable Codex pane beside Tabby's terminal content. */
@Injectable()
export class CodexSidebarService implements OnDestroy {
  private workspace?: HTMLElement
  private host?: HTMLElement
  private grip?: HTMLElement
  private style?: HTMLStyleElement
  private panels = new Map<string, ComponentRef<CodexPanelComponent>>()
  private activeCwd = ''
  private width = 420
  private dragStartX = 0
  private dragStartWidth = 0
  private dragPointerId = -1
  private dragging = false

  constructor (
    private application: ApplicationRef,
    private resolver: ComponentFactoryResolver,
    private injector: Injector,
  ) {
    try {
      const saved = Number(window.localStorage.getItem(WIDTH_KEY))
      if (Number.isFinite(saved) && saved > 0) this.width = saved
    } catch { /* Local storage can be unavailable in private mode. */ }
  }

  show (cwd: string, source?: BaseTerminalTabComponent<any>): void {
    this.ensureHost()
    let panel = this.panels.get(cwd)
    if (!panel) {
      panel = this.resolver.resolveComponentFactory(CodexPanelComponent).create(this.injector)
      panel.instance.cwd = cwd
      if (source) panel.instance.sourceTerminal = source
      panel.instance.closeRequested.subscribe(() => this.hide())
      this.application.attachView(panel.hostView)
      this.host!.insertBefore(panel.location.nativeElement, this.grip!)
      this.panels.set(cwd, panel)
      panel.changeDetectorRef.detectChanges()
    } else if (source) {
      panel.instance.bindSource(source)
    }
    this.activeCwd = cwd
    for (const [key, item] of this.panels) {
      item.location.nativeElement.style.display = key === cwd ? '' : 'none'
    }
    this.host!.hidden = false
    this.host!.style.width = `${clampSidebarWidth(this.width, window.innerWidth)}px`
    if (!panel.instance.connected && !panel.instance.loading) void panel.instance.reconnect()
  }

  hide (): void {
    if (this.host) this.host.hidden = true
    this.stopResize()
  }

  get isVisible (): boolean { return !!this.host && !this.host.hidden }
  get currentCwd (): string { return this.activeCwd }

  private ensureHost (): void {
    if (this.host?.isConnected) return
    const mount = findSidebarMount(document.querySelector('app-root') as HTMLElement | null)
    if (!mount) throw new Error('找不到 Tabby 标签内容区，无法打开 Codex 侧栏')
    if (!this.style) {
      this.style = document.createElement('style')
      this.style.textContent = require('./sidebar.css')
      document.head.appendChild(this.style)
    }
    this.host = document.createElement('aside')
    this.host.className = 'codex-agent-sidebar'
    this.host.setAttribute('aria-label', 'AI Agent 侧栏')
    this.grip = document.createElement('div')
    this.grip.className = 'codex-sidebar-grip'
    this.grip.setAttribute('role', 'separator')
    this.grip.setAttribute('aria-label', '拖动调整 Codex 侧栏宽度')
    this.grip.addEventListener('pointerdown', this.startResize)
    this.host.appendChild(this.grip)
    if (mount.wrap) {
      this.workspace = document.createElement('div')
      this.workspace.className = 'codex-agent-workspace'
      mount.container.insertBefore(this.workspace, mount.main)
      this.workspace.appendChild(this.host)
      this.workspace.appendChild(mount.main)
    } else {
      this.workspace = undefined
      mount.container.insertBefore(this.host, mount.main)
    }
    for (const panel of this.panels.values()) this.host.insertBefore(panel.location.nativeElement, this.grip)
  }

  private readonly startResize = (event: PointerEvent): void => {
    if (event.button !== 0 || !this.host) return
    this.dragging = true
    this.dragStartX = event.clientX
    this.dragStartWidth = this.host.getBoundingClientRect().width
    this.dragPointerId = event.pointerId
    this.grip?.setPointerCapture(event.pointerId)
    this.host.classList.add('codex-resizing')
    document.addEventListener('pointermove', this.resize)
    document.addEventListener('pointerup', this.stopResize)
    document.addEventListener('pointercancel', this.stopResize)
    event.preventDefault()
  }

  private readonly resize = (event: PointerEvent): void => {
    if (!this.dragging || !this.host) return
    this.width = clampSidebarWidth(this.dragStartWidth + event.clientX - this.dragStartX, window.innerWidth)
    this.host.style.width = `${this.width}px`
  }

  private readonly stopResize = (): void => {
    if (!this.dragging) return
    this.dragging = false
    if (this.dragPointerId >= 0 && this.grip?.hasPointerCapture(this.dragPointerId)) this.grip.releasePointerCapture(this.dragPointerId)
    this.dragPointerId = -1
    this.host?.classList.remove('codex-resizing')
    document.removeEventListener('pointermove', this.resize)
    document.removeEventListener('pointerup', this.stopResize)
    document.removeEventListener('pointercancel', this.stopResize)
    try { window.localStorage.setItem(WIDTH_KEY, String(this.width)) } catch { /* See constructor. */ }
  }

  ngOnDestroy (): void {
    this.stopResize()
    this.grip?.removeEventListener('pointerdown', this.startResize)
    for (const panel of this.panels.values()) {
      this.application.detachView(panel.hostView)
      panel.destroy()
    }
    this.panels.clear()
    const main = this.workspace?.querySelector(':scope > .content')
    if (main && this.workspace?.parentElement) this.workspace.parentElement.insertBefore(main, this.workspace)
    this.workspace?.remove()
    this.host?.remove()
    this.style?.remove()
  }
}
