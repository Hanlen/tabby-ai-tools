import type { OpenAICompletionsCompat } from '@earendil-works/pi-ai'

/** Provider identity is lost when registering models under the isolated tabby ID. */
export function providerCompat (profile: { provider: string }): OpenAICompletionsCompat | undefined {
  if (profile.provider === 'kimi-coding') return {
    supportsDeveloperRole: false, maxTokensField: 'max_tokens', supportsStore: false,
    supportsStrictMode: false, requiresReasoningContentOnAssistantMessages: true,
  }
  return undefined
}

/** Keep the existing Tabby connection settings meaningful at Pi's request boundary. */
export function providerPayload (profile: any, payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload
  const body = payload as Record<string, any>
  const effort = profile.reasoningEffort
  if (profile.provider === 'openai' || profile.provider === 'custom' && profile.apiFormat === 'responses') {
    if (effort) body.reasoning = { ...body.reasoning, effort }
  } else if (profile.provider === 'claude') {
    delete body.thinking
    if (profile.thinking === 'enabled') body.thinking = { type: 'adaptive' }
    if (profile.thinking === 'disabled') body.thinking = { type: 'disabled' }
    if (effort) body.output_config = { ...body.output_config, effort }
  } else {
    delete body.thinking
    delete body.enable_thinking
    delete body.reasoning_effort
    const alwaysThinks = profile.provider === 'kimi' && /^kimi-(k3(?:\.1-pro)?|k2\.7-code)(?:-highspeed)?$/i.test(profile.model)
    if ((alwaysThinks || profile.provider === 'kimi-coding' && /^k3\.1-pro(?:-highspeed)?$/i.test(profile.model)) && profile.thinking === 'disabled') {
      throw new Error('此 Kimi 模型仅支持思考模式，请选择服务商默认或开启')
    }
    if (profile.provider !== 'custom' && profile.thinking !== 'default' && !alwaysThinks) {
      if (profile.provider === 'bailian-coding') body.enable_thinking = profile.thinking === 'enabled'
      else body.thinking = { type: profile.thinking }
    }
    if (effort && (profile.provider === 'custom' || profile.thinking !== 'disabled')) body.reasoning_effort = effort
  }
  return body
}
