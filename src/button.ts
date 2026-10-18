import { Injectable } from '@angular/core'
import { AppService, ConfigService, NotificationsService, SplitTabComponent, ToolbarButton, ToolbarButtonProvider } from 'tabby-core'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { CodexSidebarService } from './sidebar.service'

@Injectable()
export class CodexToolbarButtonProvider extends ToolbarButtonProvider {
  constructor (private app: AppService, private config: ConfigService, private sidebar: CodexSidebarService, private notifications: NotificationsService) { super() }

  provide (): ToolbarButton[] {
    return [{ icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2a3 3 0 0 1 3 3v1h3a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3h3V5a3 3 0 0 1 3-3Zm0 2a1 1 0 0 0-1 1v1h2V5a1 1 0 0 0-1-1ZM6 8a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1H6Zm3 4a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z"/></svg>', title: 'AI Tools', weight: 8, click: () => { void this.open().catch(error => console.error("Could not open Codex sidebar:", error)) } }]
  }

  private async open (): Promise<void> {
    const configured = String(this.config.store.codexAgent.cwd || '').trim()
    let cwd = configured || os.homedir()
    const current = this.app.activeTab
    const active = current instanceof SplitTabComponent ? current.getFocusedTab() : current
    const sourceTerminal = active instanceof BaseTerminalTabComponent ? active : undefined
    if (!configured) {
      try {
        const possible = await sourceTerminal?.session?.getWorkingDirectory()
        if (possible && fs.existsSync(possible) && fs.statSync(possible).isDirectory()) cwd = possible
      } catch { /* The terminal may have closed while its directory was queried. */ }
    }
    cwd = path.resolve(cwd)
    try { this.sidebar.show(cwd, sourceTerminal) } catch (error: any) {
      this.notifications.error('无法打开 AI Tools 侧栏', String(error?.message || error))
      throw error
    }
  }
}
