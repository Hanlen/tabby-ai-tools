import MarkdownIt from 'markdown-it'
import highlight from 'highlight.js/lib/common'
import powershell from 'highlight.js/lib/languages/powershell'
import dockerfile from 'highlight.js/lib/languages/dockerfile'

export interface MarkdownBlock { html: string }

/** Only these URLs may leave the conversation through the host's browser. */
export function markdownExternalUrl (value: string): string | undefined {
  if (/[\u0000-\u0020\u007f]/.test(value)) return undefined
  try {
    const url = new URL(value)
    if (['https:', 'http:', 'mailto:'].includes(url.protocol)) return url.href
  } catch { /* Relative paths and incomplete streaming links remain inert. */ }
  return undefined
}

highlight.registerLanguage('powershell', powershell)
highlight.registerLanguage('dockerfile', dockerfile)

// Bound work and retained HTML during streaming. Only explicit, bundled grammars
// run: unlabeled/unknown languages and large blocks use markdown-it's escaping.
const highlightedCode = new Map<string, string>()
function highlightCode (code: string, language: string): string {
  language = language.toLowerCase()
  if (!language || code.length > 20000 || !highlight.getLanguage(language)) return ''
  const key = `${language}\0${code}`
  const cached = highlightedCode.get(key)
  if (cached !== undefined) return cached
  try {
    const result = highlight.highlight(code, { language, ignoreIllegals: true }).value
    if (highlightedCode.size >= 32) highlightedCode.delete(highlightedCode.keys().next().value!)
    highlightedCode.set(key, result)
    return result
  } catch { return '' }
}

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true, maxNesting: 32, highlight: highlightCode })
const escape = markdown.utils.escapeHtml

markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  const token = tokens[index]
  const href = markdownExternalUrl(String(token.attrGet('href') || ''))
  // Keep relative file labels readable without navigating the Electron window.
  token.attrs = (token.attrs || []).filter(([name]) => name !== 'href')
  if (href) {
    token.attrSet('href', href)
    token.attrSet('target', '_blank')
    token.attrSet('rel', 'noopener noreferrer')
  }
  return renderer.renderToken(tokens, index, options)
}

// Never fetch an image just because a model included it in a reply.
markdown.renderer.rules.image = (tokens, index, options, env, renderer) => {
  const token = tokens[index]
  const alt = escape(renderer.renderInlineAsText(token.children || [], options, env) || 'image')
  const href = markdownExternalUrl(String(token.attrGet('src') || ''))
  return href ? `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${alt}</a>` : `<span>${alt}</span>`
}

markdown.renderer.rules.table_open = (_tokens, _index, _options, env) =>
  `<div class="codex-md-table" tabindex="0" role="region" aria-label="${escape(String(env?.tableLabel || 'Table'))}"><table>\n`
markdown.renderer.rules.table_close = () => '</table></div>\n'
for (const name of ['th_open', 'td_open']) {
  markdown.renderer.rules[name] = (tokens, index, options, _env, renderer) => {
    const token = tokens[index]
    const alignment = String(token.attrGet('style') || '').match(/^text-align:(left|center|right)$/)?.[1]
    token.attrs = (token.attrs || []).filter(([key]) => key !== 'style')
    if (alignment) token.attrSet('class', `codex-md-align-${alignment}`)
    if (name === 'th_open') token.attrSet('scope', 'col')
    return renderer.renderToken(tokens, index, options)
  }
}

/** Keep complete root blocks independent so streaming only replaces changed HTML. */
export function renderMarkdown (source: string, tableLabel = 'Table'): MarkdownBlock[] {
  try {
    const env = { tableLabel }
    const tokens = markdown.parse(source, env)
    const blocks: MarkdownBlock[] = []
    for (let start = 0; start < tokens.length;) {
      let end = start + 1
      let nesting = tokens[start].nesting
      while (nesting > 0 && end < tokens.length) nesting += tokens[end++].nesting
      blocks.push({ html: markdown.renderer.render(tokens.slice(start, end), markdown.options, env) })
      start = end
    }
    return blocks
  } catch {
    return [{ html: `<div class="codex-md-plain">${escape(source)}</div>` }]
  }
}
