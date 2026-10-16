import { Injectable, OnDestroy } from '@angular/core'
import { ConfigService, NotificationsService } from 'tabby-core'
import { Subscription } from 'rxjs'
import { AgentSettings } from './config'
import { CodexService } from './codex.service'

/** Owns the shared app-server for the entire plugin lifetime, including hidden panels. */
@Injectable()
export class CodexRuntimeService implements OnDestroy {
  private readonly subscriptions = new Subscription()
  private started = false
  private stopped = false
  private configReady = false
  private executable = ''
  private retryTimer?: ReturnType<typeof setTimeout>
  private retryDelay = 1000
  private errorReported = false

  constructor (
    private config: ConfigService,
    private codex: CodexService,
    private notifications: NotificationsService,
  ) {}

  start (): void {
    if (this.started || this.stopped) return
    this.started = true
    this.codex.client.on('connected', this.onConnected)
    this.codex.client.on('disconnected', this.onDisconnected)
    window.addEventListener('unload', this.stop)
    this.subscriptions.add(this.config.ready$.subscribe(() => {
      this.configReady = true
      void this.connect()
    }))
    this.subscriptions.add(this.config.changed$.subscribe(() => {
      if (this.configReady && this.configuredExecutable !== this.executable) void this.connect()
    }))
  }

  private get configuredExecutable (): string {
    return (this.config.store.codexAgent as AgentSettings).executable.trim() || 'codex'
  }

  private async connect (): Promise<void> {
    if (this.stopped) return
    this.clearRetry()
    const executable = this.configuredExecutable
    this.executable = executable
    try {
      await this.codex.connect(this.config.store.codexAgent as AgentSettings)
    } catch (error: any) {
      if (this.stopped || executable !== this.configuredExecutable) return
      if (!this.errorReported) {
        this.errorReported = true
        this.notifications.error('Codex 后台服务启动失败', `${error.message}。请检查 Settings → Codex AI → Codex CLI 可执行文件（codexAgent.executable），插件会自动重试。`)
      }
      this.scheduleRetry()
    }
  }

  private readonly onConnected = (): void => {
    this.clearRetry()
    this.retryDelay = 1000
    this.errorReported = false
  }

  private readonly onDisconnected = (): void => this.scheduleRetry()

  private scheduleRetry (): void {
    if (this.stopped || !this.configReady || this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      void this.connect()
    }, this.retryDelay)
    this.retryDelay = Math.min(this.retryDelay * 2, 30000)
  }

  private clearRetry (): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
  }

  private readonly stop = (): void => {
    if (this.stopped) return
    this.stopped = true
    this.clearRetry()
    this.subscriptions.unsubscribe()
    window.removeEventListener('unload', this.stop)
    this.codex.client.off('connected', this.onConnected)
    this.codex.client.off('disconnected', this.onDisconnected)
    this.codex.client.close()
  }

  ngOnDestroy (): void { this.stop() }
}
