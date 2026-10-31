import { build } from 'esbuild'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, 'dist/pi')
await mkdir(output, { recursive: true })

// Keep Pi out of Electron's Angular bundle. Its external Node process loads this
// prebuilt ESM bundle without installing SDK packages or running their scripts.
const result = await build({
  absWorkingDir: root,
  entryPoints: ['runtime/pi/sidecar.mts', 'runtime/pi/provider.mts'],
  outdir: output,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22.19',
  metafile: true,
  legalComments: 'eof',
  banner: { js: 'import { createRequire as __tabbyCreateRequire } from "node:module"; const require = __tabbyCreateRequire(import.meta.url);' },
  // ws's optional native accelerators are unnecessary for the isolated runtime.
  // Use its JavaScript implementation on every release build platform.
  define: { 'process.env.WS_NO_BUFFER_UTIL': '"1"', 'process.env.WS_NO_UTF_8_VALIDATE': '"1"' },
})

for (const entry of Object.values(result.metafile.outputs)) {
  for (const dependency of entry.imports) {
    if (dependency.external && !isBuiltin(dependency.path) && !dependency.path.startsWith('node:')) {
      throw new Error(`Pi bundle still needs an installed package: ${dependency.path}`)
    }
  }
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
const notices = ['Third-party packages included in the Tabby Pi runtime bundle.\n']
for (const [directory, manifest] of [...packages].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
  notices.push(`\n${'='.repeat(72)}\n${manifest.name}@${manifest.version}\nLicense: ${manifest.license || 'See upstream license'}\n`)
  for (const file of (await readdir(directory)).sort()) {
    if (/^(license|licence|copying|notice)(\.|$)/i.test(file)) {
      notices.push(`\n--- ${file} ---\n${await readFile(join(directory, file), 'utf8')}\n`)
    }
  }
}
await writeFile(join(output, 'THIRD_PARTY_NOTICES.txt'), notices.join(''))
console.log(`Built self-contained Pi runtime with notices for ${packages.size} packages`)
