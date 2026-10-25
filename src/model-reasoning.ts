import type { ApiProfile } from './agent-types'
import type { CodexModel } from './codex.service'

/** Conservative fallbacks when /models omits effort metadata. Unknown models stay configurable. */
export function modelReasoningEfforts (profile: ApiProfile, model: string): string[] {
  const id = model.toLowerCase()
  if (profile.runtime === 'claude-code') {
    if (/^(opus|sonnet)(\[1m\])?$/.test(id)) return ['low', 'medium', 'high']
  }
  if (profile.provider === 'deepseek') return ['low', 'high', 'max']
  if (profile.provider === 'kimi' && /^kimi-k3(?:\.1-pro)?(?:-highspeed)?$/.test(id)
    || profile.provider === 'kimi-coding' && /^(k3(?:-256k|\.1-pro(?:-highspeed)?)?|kimi-for-coding)$/.test(id)) return ['low', 'high', 'max']
  if (profile.provider === 'glm') {
    if (/^glm-5\.3(?:-|$)/.test(id)) return ['low', 'high', 'max']
    if (/^glm-5\.2(?:-|$)/.test(id)) return ['high', 'max']
  }
  if (profile.provider === 'claude') {
    if (/^claude-opus-4-[789](?:-|$)|^claude-(opus|sonnet)-5(?:-|$)/.test(id)) return ['low', 'medium', 'high', 'xhigh', 'max']
    if (/^claude-opus-4-6(?:-|$)/.test(id)) return ['low', 'medium', 'high', 'max']
    if (/^claude-opus-4-5(?:-|$)|^claude-sonnet-4-6(?:-|$)/.test(id)) return ['low', 'medium', 'high']
  }
  if (profile.provider === 'openai') {
    if (/^gpt-5(?:-(mini|nano))?(?:-\d{4}-\d{2}-\d{2})?$/.test(id)) return ['minimal', 'low', 'medium', 'high']
    // A shared supported subset; additional model-specific levels remain available via manual entry.
    if (/^gpt-(5\.[1-9]|6)(?:[.-]|$)|^o[134](?:-|$)/.test(id) && !id.includes('pro')) return ['low', 'medium', 'high']
  }
  return []
}

export function withModelReasoning (profile: ApiProfile, model: CodexModel): CodexModel {
  return { ...model, supportedReasoningEfforts: model.supportedReasoningEfforts?.length ? model.supportedReasoningEfforts
    : modelReasoningEfforts(profile, model.model).map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })) }
}
