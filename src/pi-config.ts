import { ApiProfile, PiProtocol } from './agent-types'
import { apiUrl } from './api-transport'
import type { CodexModel } from './codex.service'
import * as bundled from './pi-catalog.json'

export interface PiCatalogModel {
  id: string; name: string; api: string; baseUrl: string; contextWindow: number; maxTokens: number
  reasoning: boolean; thinkingLevels: string[]; input: string[]
}
export interface PiCatalogProvider {
  id: string; name: string; baseUrl: string; unavailableReason: string; apiKey: boolean; oauth: boolean; models: PiCatalogModel[]
}
export const piCatalog = bundled as { sdkVersion: string; source: string; providers: PiCatalogProvider[] }
export const piProtocols: PiProtocol[] = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']
export function piProvider (profile: ApiProfile): PiCatalogProvider | undefined {
  const config = profile.piConnection
  return config?.mode === 'native' ? piCatalog.providers.find(p => p.id === config.providerId) : undefined
}
export function piModel (profile: ApiProfile): PiCatalogModel | undefined { return piProvider(profile)?.models.find(m => m.id === profile.model) }
export function piModels (profile: ApiProfile): CodexModel[] {
  return (piProvider(profile)?.models || []).map(model => ({ id: model.id, model: model.id, displayName: model.name,
    supportedReasoningEfforts: model.thinkingLevels.map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })) }))
}
export function validatePiProfile (profile: ApiProfile): void {
  const config = profile.piConnection
  if (!config) { apiUrl(profile.baseUrl, ''); return }
  if (profile.runtime !== 'pi' || config.version !== 1 || !['native', 'custom'].includes(config.mode)) throw new Error('Invalid Pi connection schema')
  if (!profile.model.trim()) throw new Error('Model ID is required')
  let model: PiCatalogModel | undefined
  if (config.mode === 'native') {
    const provider = piProvider(profile)
    if (!provider) throw new Error('Unknown SDK provider')
    if (provider.unavailableReason) throw new Error(provider.unavailableReason)
    model = piModel(profile)
    if (profile.keySource === 'none') throw new Error('Native providers require an explicit credential source')
    apiUrl(profile.baseUrl || model?.baseUrl || provider.baseUrl, '')
  } else apiUrl(profile.baseUrl, '')
  if (!model) {
    if (!config.api || !piProtocols.includes(config.api)) throw new Error('Manual model: choose its protocol')
    if (!Number.isInteger(profile.contextWindow) || profile.contextWindow < 256) throw new Error('Manual model: set context window (at least 256 tokens)')
    if (!Number.isInteger(config.maxTokens) || config.maxTokens! < 256) throw new Error('Manual model: set maximum output capability (at least 256 tokens)')
  }
  const maximum = model?.maxTokens || config.maxTokens!
  if (!Number.isInteger(profile.maxOutputTokens) || profile.maxOutputTokens < 256 || profile.maxOutputTokens > maximum) throw new Error(`Output budget must be 256–${maximum} tokens`)
  if (model && profile.reasoningEffort && !model.thinkingLevels.includes(profile.reasoningEffort)) throw new Error('Unsupported thinking level for selected SDK model')
}
