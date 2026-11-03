// Generate safe DTOs with the same resolver and pinned SDK as the packaged sidecar.
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
for (const name of ['pi-ai', 'pi-coding-agent']) {
  const manifest = JSON.parse(await readFile(`node_modules/@earendil-works/${name}/package.json`, 'utf8'))
  if (manifest.version !== '1.4.0') throw new Error('Pi SDK version mismatch; expected 1.4.0')
}
const directory = await mkdtemp(join(tmpdir(), 'tabby-pi-catalog-'))
try {
  const outfile = join(directory, 'resolver.mjs')
  await build({ entryPoints: ['runtime/pi/resolver.mts'], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22.19',
    banner: { js: 'import {createRequire as __tabbyRequire} from "node:module"; const require = __tabbyRequire(import.meta.url);' } })
  const { createRuntime, catalogDTO } = await import(pathToFileURL(outfile))
  const catalog = catalogDTO(await createRuntime())
  const content = JSON.stringify(catalog) + '\n'
  if (process.argv.includes('--check')) {
    if (await readFile('src/pi-catalog.json', 'utf8') !== content) throw new Error('Pi catalog is stale; run npm run pi:catalog')
  } else await writeFile('src/pi-catalog.json', content)
  console.log(`SDK ${catalog.sdkVersion}: ${catalog.providers.length} providers; offline catalog verified`)
} finally { await rm(directory, { recursive: true, force: true }) }
