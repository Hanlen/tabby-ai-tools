import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export async function bundleTabbySkill (directory = root, check = process.argv.includes('--check')) {
  const skill = (await readFile(resolve(directory, 'skills/tabby/SKILL.md'), 'utf8')).replace(/\r\n/g, '\n')
  const operations = (await readFile(resolve(directory, 'skills/tabby/references/operations.md'), 'utf8')).replace(/\r\n/g, '\n')
  const upstream = JSON.parse(await readFile(resolve(directory, 'skills/tabby/references/upstream.json'), 'utf8'))
  const bundle = JSON.stringify({ skill: skill.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim(), operations, upstream }, null, 2) + '\n'
  const target = resolve(directory, 'src/tabby-knowledge.json')
  if (check) {
    if ((await readFile(target, 'utf8')).replace(/\r\n/g, '\n') !== bundle) throw new Error('Bundled Tabby knowledge is stale; run npm run skill:bundle')
  } else await writeFile(target, bundle)
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await bundleTabbySkill()
