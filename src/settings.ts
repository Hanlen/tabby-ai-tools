import { Component, Injectable } from '@angular/core'
import { ConfigService } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'
import { AgentSettings } from './config'

@Component({ template: require('./settings.pug') })
export class CodexSettingsComponent {
  get settings (): AgentSettings { return this.config.store.codexAgent as AgentSettings }
  constructor (public config: ConfigService) {}
  save (): void { void this.config.save() }
}

@Injectable()
export class CodexSettingsTabProvider extends SettingsTabProvider {
  id = 'codex-agent'
  icon = 'robot'
  title = 'Codex AI'
  getComponentType (): any { return CodexSettingsComponent }
}
