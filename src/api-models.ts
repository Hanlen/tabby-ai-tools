import { ApiProfile, normalizeApiProfile } from './agent-types'
import type { CodexModel } from './codex.service'
import { apiUrl, getApiJson, withAbort } from './api-transport'

/** Discover account models without inference, with one deadline including credential lookup and pagination. */
export async function discoverApiModels (configured: ApiProfile, getKey: () => Promise<string>, signal?: AbortSignal): Promise<CodexModel[]> {
  const profile = normalizeApiProfile(configured)
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  const timeout = setTimeout(abort, 30000)
  try {
    const url = apiUrl(profile.baseUrl, 'models')
    const key = await withAbort(getKey(), controller.signal)
    const headers: Record<string, string> = profile.provider === 'claude'
      ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
      : { authorization: `Bearer ${key}` }
    const models = new Map<string, CodexModel>()
    const cursors = new Set<string>()
    for (let page = 0; page < 100; page++) {
      const result = await getApiJson(url, headers, controller.signal)
      if (!Array.isArray(result?.data)) throw new Error('API 模型列表格式不兼容，请手动填写模型 ID')
      for (const item of result.data) {
        if (typeof item?.id !== 'string' || !item.id.trim() || models.has(item.id)) continue
        const levels: string[] = Array.isArray(item.effort?.supported_levels)
          ? item.effort.supported_levels.filter((value: unknown) => typeof value === 'string' && value)
          : profile.provider === 'deepseek' ? ['low', 'high', 'max'] : []
        models.set(item.id, { model: item.id, displayName: item.display_name || item.name || item.id,
          isDefault: item.id === profile.model,
          defaultReasoningEffort: levels.includes(item.effort?.default_level) ? item.effort.default_level : '',
          supportedReasoningEfforts: levels.map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })) })
      }
      if (!result.has_more) return [...models.values()]
      const cursor = result.last_id || result.data[result.data.length - 1]?.id
      if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) throw new Error('模型列表分页无效，请重试或手动填写模型 ID')
      cursors.add(cursor)
      url.searchParams.set('after_id', cursor)
    }
    throw new Error('模型列表分页超过上限，请手动填写模型 ID')
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}
