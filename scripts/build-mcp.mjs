import { build } from 'esbuild'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
const output = join(root, 'dist/mcp')
await mkdir(output, { recursive: true })
const result = await build({
  absWorkingDir: root, entryPoints: ['runtime/mcp/utility.mts'], outfile: join(output, 'utility.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node20', metafile: true, legalComments: 'eof', define: { TABBY_MCP_VERSION: JSON.stringify(version) },
})
for (const entry of Object.values(result.metafile.outputs)) for (const dependency of entry.imports) {
  if (dependency.external && !isBuiltin(dependency.path)) throw new Error(`MCP bundle requires an installed package: ${dependency.path}`)
}
// Include the license and notice files belonging to every bundled package,
// including dependencies without per-file license comments.
const packages = new Map()
for (const input of Object.keys(result.metafile.inputs).sort()) {
  if (!input.split('/').includes('node_modules')) continue
  let directory = dirname(resolve(root, input))
  while (directory !== root && dirname(directory) !== directory) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
      if (manifest.name && manifest.version) {
        packages.set(directory, manifest)
        break
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    directory = dirname(directory)
  }
}
const notices = ['Third-party packages included in the Tabby MCP runtime bundle.\n']
for (const [directory, manifest] of [...packages].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
  notices.push(`\n${'='.repeat(72)}\n${manifest.name}@${manifest.version}\nLicense: ${manifest.license || 'See upstream license'}\n`)
  for (const file of (await readdir(directory)).sort()) {
    if (/^(license|licence|copying|notice)(\.|$)/i.test(file)) {
      notices.push(`\n--- ${file} ---\n${await readFile(join(directory, file), 'utf8')}\n`)
    }
  }
}
await writeFile(join(output, 'THIRD_PARTY_NOTICES.txt'), notices.join(''))
await build({ absWorkingDir: root, entryPoints: ['runtime/mcp/electron-host.cts'], outfile: join(output, 'electron-host.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['electron'], legalComments: 'eof' })
await mkdir(join(root, 'artifacts'), { recursive: true })
for (const entry of ['server.mts', 'policy.cts', 'utility-rpc.cts']) await build({ absWorkingDir: root, entryPoints: ['runtime/mcp/' + entry],
  outfile: join(root, 'artifacts/mcp-' + entry.split('.')[0] + '.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node20', define: { TABBY_MCP_VERSION: JSON.stringify(version) } })
console.log(`Built self-contained MCP utility with notices for ${packages.size} packages`)
