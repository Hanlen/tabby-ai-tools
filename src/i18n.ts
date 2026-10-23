const en: Record<string, string> = require('./locales/en.json')
const zhCN: Record<string, string> = require('./locales/zh-CN.json')
const zhTW: Record<string, string> = require('./locales/zh-TW.json')
const es: Record<string, string> = require('./locales/es.json')
const fr: Record<string, string> = require('./locales/fr.json')
const de: Record<string, string> = require('./locales/de.json')
const pt: Record<string, string> = require('./locales/pt.json')
const ru: Record<string, string> = require('./locales/ru.json')
const ja: Record<string, string> = require('./locales/ja.json')
const ko: Record<string, string> = require('./locales/ko.json')
const ar: Record<string, string> = require('./locales/ar.json')
const hi: Record<string, string> = require('./locales/hi.json')

export const SUPPORTED_LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'zh-CN', name: '简体中文' },
  { code: 'zh-TW', name: '繁體中文' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
  { code: 'pt', name: 'Português' },
  { code: 'ru', name: 'Русский' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'ar', name: 'العربية' },
  { code: 'hi', name: 'हिन्दी' },
] as const

export type AgentLanguage = typeof SUPPORTED_LANGUAGES[number]['code']
const catalogs: Record<AgentLanguage, Record<string, string>> = { en, 'zh-CN': zhCN, 'zh-TW': zhTW, es, fr, de, pt, ru, ja, ko, ar, hi }
let language: AgentLanguage = 'en'
const cache = new Map<string, string>()
const listeners = new Set<() => void>()

export function normalizeLanguage (value: unknown): AgentLanguage {
  const tag = String(value || '').replace(/_/g, '-').toLowerCase()
  if (/^zh(?:-|$)/.test(tag)) return /(?:^|-)(?:tw|hk|mo|hant)(?:-|$)/.test(tag) ? 'zh-TW' : 'zh-CN'
  return SUPPORTED_LANGUAGES.find(item => item.code === tag.split('-')[0])?.code || 'en'
}

export function setLanguage (value: unknown): void {
  const next = normalizeLanguage(value)
  if (next === language) return
  language = next
  cache.clear()
  for (const listener of listeners) listener()
}

export function getLanguage (): AgentLanguage { return language }
export function textDirection (): 'ltr' | 'rtl' { return language === 'ar' ? 'rtl' : 'ltr' }
export function onLanguageChange (listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function format (text: string, parameters: readonly unknown[]): string {
  return text.replace(/\{(\d+)\}/g, (token, index) => Number(index) < parameters.length ? String(parameters[Number(index)] ?? '') : token)
}

// Existing runtime messages stay in their original form internally, including
// completion checks and persisted logs. Match them only when displaying UI text.
const patterns = Object.keys(zhCN)
  .filter(source => /\{\d+\}/.test(source))
  .sort((a, b) => b.replace(/\{\d+\}/g, '').length - a.replace(/\{\d+\}/g, '').length)
  .map(source => {
    const indices: number[] = []
    const escaped = source.split(/(\{\d+\})/g).map(part => {
      if (/^\{\d+\}$/.test(part)) {
        indices.push(Number(part.slice(1, -1)))
        return '([\\s\\S]*?)'
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }).join('')
    return { source, indices, expression: new RegExp(`^${escaped}$`) }
  })

// These positions contain plugin-generated labels, rather than user data.
const nestedLabels: Record<string, number[]> = {
  '无人值守 · 不询问 · {0}': [0],
  '已用 {0}%{1}': [1],
  '测试成功：{0} · {1} ms{2}': [2],
  '模型已设为 {0} · 推理强度 {1}，下一回合生效': [1],
  '任务未完成：{0}': [0],
  '任务未完成：目标状态 {0}': [0],
  '已达到用量或请求频率上限，请等待额度恢复后重试。{0}': [0],
  '额度信息：{0}。': [0],
}
const suffixes = ['；原会话仍可用', '；已发送到终端的命令可能仍在运行，请检查终端', '\nCodex 正在自动重试…']

/** Translate plugin-owned UI text; never apply this to user or model content. */
export function translate (value: unknown, parameters?: readonly unknown[]): string {
  return render(value, parameters, 0)
}

function render (value: unknown, parameters: readonly unknown[] | undefined, depth: number): string {
  const source = String(value ?? '')
  const catalog = catalogs[language]
  const direct = Object.prototype.hasOwnProperty.call(catalog, source) ? catalog[source] : undefined
  const fallback = Object.prototype.hasOwnProperty.call(en, source) ? (en as Record<string, string>)[source] : undefined
  if (direct || fallback) return format(direct || fallback!, parameters || [])
  if (parameters || language === 'zh-CN' || depth > 8 || !/\p{Script=Han}/u.test(source)) return source
  const cached = cache.get(source)
  if (cached !== undefined) return cached
  for (const suffix of suffixes) {
    if (source.length > suffix.length && source.endsWith(suffix)) {
      return render(source.slice(0, -suffix.length), undefined, depth + 1) + render(suffix, undefined, depth + 1)
    }
  }
  let result = source
  for (const pattern of patterns) {
    const match = pattern.expression.exec(source)
    if (!match) continue
    const values: string[] = []
    pattern.indices.forEach((index, position) => { values[index] = match[position + 1] })
    for (const index of nestedLabels[pattern.source] || []) values[index] = render(values[index], undefined, depth + 1)
    result = format(catalog[pattern.source] || (en as Record<string, string>)[pattern.source] || pattern.source, values)
    break
  }
  if (result === source) {
    const separator = source.indexOf('：')
    const prefix = source.slice(0, separator)
    if (separator > 0 && Object.prototype.hasOwnProperty.call(en, prefix)) {
      const colon = language === 'zh-TW' || language === 'ja' ? '：' : ': '
      result = render(prefix, undefined, depth + 1) + colon + render(source.slice(separator + 1), undefined, depth + 1)
    } else if (source.includes('\n')) {
      result = source.split('\n').map(line => render(line, undefined, depth + 1)).join('\n')
    }
  }
  if (cache.size >= 2000) cache.clear()
  cache.set(source, result)
  return result
}

export function formatDateTime (time: number): string {
  return new Date(time).toLocaleString(language)
}
