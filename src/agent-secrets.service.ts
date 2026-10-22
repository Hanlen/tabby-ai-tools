import { Injectable } from '@angular/core'
import { ApiProfile, apiKeySource } from './agent-types'

@Injectable()
export class AgentSecretsService {
  async read (profile: ApiProfile): Promise<string> {
    const source = apiKeySource(profile)
    if (source === 'direct') {
      const value = profile.apiKey?.trim()
      if (!value) throw new Error('请在 AI Tools 设置中填写 API Key')
      return value
    }
    if (source === 'environment') {
      const value = process.env[profile.apiKeyEnv]?.trim()
      if (!value) throw new Error(`未设置环境变量 ${profile.apiKeyEnv || 'API Key'}；修改后请重启 Tabby`)
      return value
    }
    throw new Error('此连接仍使用旧 Vault 配置；插件不再访问 Vault，请在 AI Tools 设置中改为直接输入 API Key 或环境变量')
  }
}
