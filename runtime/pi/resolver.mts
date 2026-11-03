import { InMemoryCredentialStore, getSupportedThinkingLevels, type Model, type Api } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { providerCompat } from './provider.mjs'


export const supportedApis = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'] as const
// These require identity/endpoint fields or a separate authentication lifecycle.
const deferred: Record<string, string> = {
  'amazon-bedrock': 'AWS identity and dependency adapter pending', 'google-vertex': 'Google Cloud identity adapter pending',
  azure: 'Azure deployment adapter pending', 'cloudflare-ai-gateway': 'Cloudflare account/gateway adapter pending',
  'cloudflare-workers-ai': 'Cloudflare account adapter pending', 'github-copilot': 'Copilot authentication adapter pending',
  'openai-codex': 'Use the independent Codex CLI connection', radius: 'Radius protocol adapter pending',
  mistral: 'Mistral Conversations protocol adapter pending', typesafe: 'No offline chat catalog available',
}
export async function createRuntime () {
  return ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    refreshOnCreate: false, allowModelNetwork: false })
}
export function providerStatus (runtime: ModelRuntime, id: string): string {
  const provider = runtime.getProvider(id)
  if (!provider) return 'Unknown SDK provider'
  if (deferred[id]) return deferred[id]
  if (!provider.auth.apiKey) return 'OAuth adapter pending'
  if (runtime.getModels(id).some(m => !supportedApis.includes(m.api as any))) return 'Protocol adapter pending'
  return ''
}
export function catalogDTO (runtime: ModelRuntime) {
  return { sdkVersion: '1.4.0', source: 'SDK bundled catalog', providers: runtime.getProviders().map(p => ({
    id: p.id, name: p.name, baseUrl: p.baseUrl || '', unavailableReason: providerStatus(runtime, p.id),
    apiKey: !!p.auth.apiKey, oauth: !!p.auth.oauth,
    models: runtime.getModels(p.id).map(m => ({ id: m.id, name: m.name, api: m.api, baseUrl: m.baseUrl,
      contextWindow: m.contextWindow, maxTokens: m.maxTokens, reasoning: m.reasoning,
      thinkingLevels: getSupportedThinkingLevels(m), input: m.input, cost: m.cost })),
  })) }
}
function checkUrl (value: string) {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash ||
    url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Endpoint requires HTTPS (HTTP only on loopback), without credentials, query or fragment')
}
/** One fresh private runtime per connection. Never reads ~/.pi or resolves a fallback account. */
export async function resolveConnection (profile: any, key: string) {
  const runtime = await createRuntime()
  const config = profile.piConnection
  if (config && (config.version !== 1 || !['native', 'custom'].includes(config.mode))) throw new Error('Invalid Pi connection schema')
  let model: Model<Api> | undefined
  let providerId = 'tabby'
  if (config?.version === 1 && config.mode === 'native') {
    providerId = config.providerId
    const reason = providerStatus(runtime, providerId)
    if (reason) throw new Error(reason)
    if (!key) throw new Error('The selected connection requires an API key')
    if (profile.baseUrl) { checkUrl(profile.baseUrl); runtime.registerProvider(providerId, { baseUrl: profile.baseUrl }) }
    model = runtime.getModel(providerId, profile.model)
    if (!model) {
      if (!supportedApis.includes(config.api)) throw new Error('A manual native model requires an explicit protocol')
      runtime.registerProvider(providerId, { ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
        models: [manualModel(profile, config.api)] })
      model = runtime.getModel(providerId, profile.model)
    }
  } else {
    const api = config?.mode === 'custom' ? config.api : profile.provider === 'claude' ? 'anthropic-messages'
      : profile.provider === 'openai' || profile.provider === 'custom' && profile.apiFormat === 'responses' ? 'openai-responses' : 'openai-completions'
    if (!supportedApis.includes(api)) throw new Error('Unsupported custom protocol')
    checkUrl(profile.baseUrl)
    const baseUrl = api === 'anthropic-messages' ? profile.baseUrl.replace(/\/v1\/?$/, '') : profile.baseUrl
    runtime.registerProvider(providerId, { baseUrl, api, apiKey: 'tabby-runtime-key', authHeader: !!key,
      models: [config ? manualModel(profile, api) : { id: profile.model, name: profile.model, api, input: ['text'],
        reasoning: profile.thinking === 'enabled' || profile.thinking !== 'disabled' && !!profile.reasoningEffort,
        compat: providerCompat(profile), thinkingLevelMap: { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
        contextWindow: profile.contextWindow || 128000, maxTokens: profile.maxOutputTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] })
    model = runtime.getModel(providerId, profile.model)
  }
  await runtime.setRuntimeApiKey(providerId, key || 'tabby-no-key')
  if (!model) throw new Error('Pi model registration failed')
  checkUrl(model.baseUrl)
  if (!supportedApis.includes(model.api as any)) throw new Error('Model protocol adapter pending')
  if (profile.maxOutputTokens > model.maxTokens) throw new Error(`Output budget exceeds model maximum (${model.maxTokens})`)
  const levels = getSupportedThinkingLevels(model)
  if (config && profile.reasoningEffort && !levels.includes(profile.reasoningEffort)) throw new Error('Unsupported thinking level for selected SDK model')
  const thinkingLevel = !config
    ? (['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(profile.reasoningEffort) ? profile.reasoningEffort : profile.thinking === 'enabled' ? 'medium' : 'off')
    : profile.thinking === 'disabled' ? 'off' : profile.reasoningEffort || (profile.thinking === 'enabled' ? (levels.includes('medium') ? 'medium' : levels.find(l => l !== 'off')) : undefined)
  return { runtime, model, thinkingLevel }
}
function manualModel (profile: any, api: Api) {
  if (!Number.isInteger(profile.contextWindow) || profile.contextWindow < 256) throw new Error('Manual models require an explicit context window (at least 256 tokens)')
  const maximum = profile.piConnection.maxTokens
  if (!Number.isInteger(maximum) || maximum < 256) throw new Error('Manual models require an explicit model maximum output')
  return { id: profile.model, name: profile.model, api, input: ['text' as const], reasoning: !!profile.piConnection.reasoning,
    contextWindow: profile.contextWindow, maxTokens: maximum, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
}
