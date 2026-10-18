import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import TabbyCoreModule, { ConfigProvider, ToolbarButtonProvider } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'
import { CodexConfigProvider } from './config'
import { CodexService } from './codex.service'
import { CodexRuntimeService } from './codex-runtime.service'
import { CodexPanelComponent } from './codex-panel.component'
import { CodexToolbarButtonProvider } from './button'
import { CodexSettingsComponent, CodexSettingsTabProvider } from './settings'
import { CodexTerminalOutputService } from './terminal-output.service'
import { CodexSidebarService } from './sidebar.service'
import { TabbyTabToolsService } from './tab-tools'
import { AgentBackendFactory } from './agent-backend.service'
import { AgentSecretsService } from './agent-secrets.service'
import { TaskMemoryService } from './task-memory.service'

@NgModule({
  imports: [CommonModule, FormsModule, TabbyCoreModule],
  declarations: [CodexPanelComponent, CodexSettingsComponent],
  entryComponents: [CodexPanelComponent, CodexSettingsComponent],
  providers: [
    CodexService,
    AgentBackendFactory,
    AgentSecretsService,
    TaskMemoryService,
    CodexRuntimeService,
    CodexTerminalOutputService,
    TabbyTabToolsService,
    CodexSidebarService,
    { provide: ConfigProvider, useClass: CodexConfigProvider, multi: true },
    { provide: ToolbarButtonProvider, useClass: CodexToolbarButtonProvider, multi: true },
    { provide: SettingsTabProvider, useClass: CodexSettingsTabProvider, multi: true },
  ],
})
export default class CodexAgentModule {
  constructor (runtime: CodexRuntimeService) { runtime.start() }
}
