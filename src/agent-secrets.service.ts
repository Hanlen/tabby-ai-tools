import { Injectable } from '@angular/core'
import { VaultService } from 'tabby-core'
import { ApiProfile, apiKeySource } from './agent-types'

@Injectable()
export class AgentSecretsService {
  constructor (private vault: VaultService) {}
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
    if (!this.vault.isEnabled()) throw new Error('请先在 Tabby 设置中启用 Vault，或使用环境变量保存密钥')
    const secret = await this.vault.getSecret('tabby-agent-api', { profileId: profile.id })
    if (!secret?.value) throw new Error('此连接尚未保存 API Key')
    return secret.value
  }
  async save (profile: ApiProfile, value: string): Promise<void> {
    if (!this.vault.isEnabled()) throw new Error('请先在 Tabby 设置中启用 Vault，或改用环境变量')
    if (!value.trim()) throw new Error('API Key 不能为空')
    const key = { profileId: profile.id }
    const existing = await this.vault.getSecret('tabby-agent-api', key)
    const secret = { type: 'tabby-agent-api', key, value: value.trim() }
    if (existing) await this.vault.updateSecret(existing, secret)
    else await this.vault.addSecret(secret)
  }
}
