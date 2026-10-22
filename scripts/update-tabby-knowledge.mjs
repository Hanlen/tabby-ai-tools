import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import { bundleTabbySkill } from './bundle-tabby-skill.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repository = 'Eugeny/tabby'
export const sourcePaths = [
  'README.md',
  'LICENSE',
  'tabby-core/src/services/app.service.ts',
  'tabby-core/src/services/profiles.service.ts',
  'tabby-core/src/services/commands.service.ts',
  'tabby-core/src/services/hotkeys.service.ts',
  'tabby-core/src/components/splitTab.component.ts',
  'tabby-core/src/api/profileProvider.ts',
  'tabby-core/src/hotkeys.ts',
  'tabby-terminal/src/hotkeys.ts',
  'tabby-ssh/src/hotkeys.ts',
  'tabby-settings/src/api.ts',
]

export function summarizeSource (path, source) {
  if (path === 'LICENSE') return source.trim()
  if (path === 'README.md') {
    // Keep the host feature summary, excluding third-party catalogs and installation prose.
    return source.split(/\r?\n/).filter(line => /^\* /.test(line) && !/https?:|<img/.test(line)).slice(0, 60).join('\n')
  }
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const lines = []
  const printer = ts.createPrinter({ removeComments: true })
  for (const node of file.statements) {
    if (!(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export)) continue
    if (ts.isClassDeclaration(node)) {
      lines.push(`class ${node.name?.text || '(default)'} {`)
      for (const member of node.members) {
        if (ts.getCombinedModifierFlags(member) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) continue
        if (member.getFullText(file).includes('@hidden') || member.name?.getText(file).startsWith('_')) continue
        if (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
          const signature = source.slice(member.getStart(file), member.body?.getStart(file) ?? member.end).trim()
          lines.push(`  ${signature};`)
        }
      }
      lines.push('}')
    } else if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) lines.push(printer.printNode(ts.EmitHint.Unspecified, node, file))
  }
  // Hotkey providers are often default exports with method bodies; extract declared ID/name pairs too.
  const hotkeys = [...source.matchAll(/id:\s*['"`]([^'"`]+)['"`][\s\S]{0,200}?name:\s*([^\n]+)/g)].map(match => ({ id: match[1], name: match[2].trim() }))
  return { api: lines.join('\n'), ...(hotkeys.length ? { hotkeys } : {}) }
}

async function request (url, json = false) {
  const headers = { 'User-Agent': 'tabby-ai-tools-knowledge-sync', Accept: json ? 'application/vnd.github+json' : 'text/plain' }
  if (json && process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) })
      if (!response.ok) throw new Error(`Upstream request failed: ${response.status} ${url}`)
      return json ? await response.json() : await response.text()
    } catch (error) {
      if (attempt === 2) throw error
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)))
    }
  }
}

export async function updateTabbyKnowledge ({ directory = root, fetchSource = request } = {}) {
  const head = await fetchSource(`https://api.github.com/repos/${repository}/commits/master`, true)
  if (!/^[a-f0-9]{40}$/.test(head.sha)) throw new Error('Invalid upstream commit')
  // Every source comes from one immutable commit; publish only after all requests succeed.
  const sources = await Promise.all(sourcePaths.map(async path => {
    const file = await fetchSource(`https://api.github.com/repos/${repository}/contents/${path}?ref=${head.sha}`, true)
    if (file.encoding !== 'base64' || typeof file.content !== 'string') throw new Error(`Invalid upstream encoding: ${path}`)
    const content = Buffer.from(file.content, 'base64').toString('utf8')
    if (typeof content !== 'string' || !content.trim() || content.length > 1000000) throw new Error(`Invalid upstream source: ${path}`)
    return { path, url: `https://github.com/${repository}/blob/${head.sha}/${path}`, sha256: createHash('sha256').update(content).digest('hex'), summary: summarizeSource(path, content) }
  }))
  const target = resolve(directory, 'skills/tabby/references/upstream.json')
  let previous
  try { previous = JSON.parse(await readFile(target, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const changed = JSON.stringify(previous?.sources) !== JSON.stringify(sources)
  const snapshot = { repository, license: 'MIT', commit: head.sha, checkedAt: new Date().toISOString(), sources }
  // Avoid timestamp-only changes in the weekly PR when upstream capabilities are unchanged.
  if (!changed) { console.log('Official Tabby capability sources are unchanged.'); return false }
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.tmp`
  await writeFile(temporary, JSON.stringify(snapshot, null, 2) + '\n')
  await rename(temporary, target)
  await bundleTabbySkill(directory)
  console.log(`Updated Tabby capability sources at ${head.sha}`)
  return true
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await updateTabbyKnowledge()
