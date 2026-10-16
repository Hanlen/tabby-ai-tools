// Enumerate only project test files; no shell glob or recursive discovery.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const directory = path.join(root, 'test')
const files = fs.readdirSync(directory, { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.test.js'))
  .map(entry => path.join(directory, entry.name))
  .sort()

if (!files.length) {
  console.error('No test/*.test.js files found')
  process.exitCode = 1
} else {
  const result = spawnSync(process.execPath, ['--test', ...files], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
  })
  if (result.error) console.error(result.error.message)
  process.exitCode = result.status ?? 1
}
