import { Injectable, NgZone, OnDestroy } from '@angular/core'
import { ConfigService, LocaleService } from 'tabby-core'
import { Subscription } from 'rxjs'
import { setLanguage } from './i18n'

/** Keep plugin translations in sync with Tabby or the plugin's override. */
@Injectable()
export class AgentI18nService implements OnDestroy {
  private readonly subscriptions = new Subscription()
  private started = false

  constructor (private config: ConfigService, private locale: LocaleService, private zone: NgZone) {}

  start (): void {
    if (this.started) return
    this.started = true
    this.subscriptions.add(this.config.ready$.subscribe(() => this.refresh()))
    this.subscriptions.add(this.config.changed$.subscribe(() => this.refresh()))
    this.subscriptions.add(this.locale.localeChanged$.subscribe(() => this.refresh()))
  }

  private refresh (): void {
    const selected = this.config.store.codexAgent?.language
    this.zone.run(() => setLanguage(selected && selected !== 'auto' ? selected : this.locale.getLocale()))
  }

  ngOnDestroy (): void { this.subscriptions.unsubscribe() }
}
