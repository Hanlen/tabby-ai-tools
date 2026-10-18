import { Injectable } from '@angular/core'
import { ConfigService, PlatformService } from 'tabby-core'
import * as path from 'path'
import { TaskMemory, TaskMemoryStore } from './task-memory'

/** One local library shared by API providers and Codex; no inference or external lookup. */
@Injectable()
export class TaskMemoryService {
  private instance?: TaskMemory
  constructor (private config: ConfigService, private platform: PlatformService) {}
  get enabled (): boolean {
    const enabled = this.config.store.codexAgent.taskMemoryEnabled !== false
    if (!enabled) this.instance?.clearRuns()
    return enabled
  }
  get activeLibrary (): TaskMemory | undefined { return this.instance }
  get library (): TaskMemory {
    if (!this.instance) {
      const configPath = this.platform.getConfigPath()
      if (!configPath) throw new Error('无法定位配置目录，任务流程库暂不可用')
      this.instance = new TaskMemory(new TaskMemoryStore(path.join(path.dirname(configPath), 'tabby-agent-memory')))
    }
    return this.instance
  }
}
