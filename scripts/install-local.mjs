import { existsSync, mkdirSync, copyFileSync, cpSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginsDir = process.argv[2]
if (!pluginsDir) {
  console.error('用法：npm run install:tabby -- "<Tabby 的 Open Plugins Directory 打开的路径>"')
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'))
if (!manifest.name?.startsWith('tabby-') || !manifest.keywords?.includes('tabby-plugin') || !manifest.author || manifest.main !== 'dist/index.js') {
  console.error('package.json 缺少 Tabby 插件识别字段：name、keywords、author 或 main')
  process.exit(1)
}
if (!existsSync(join(projectDir, manifest.main))) {
  console.error('缺少 dist/index.js，请先运行 npm run build')
  process.exit(1)
}

const root = resolve(pluginsDir)
const modulesDir = basename(root) === 'node_modules' ? root : join(root, 'node_modules')
const destination = join(modulesDir, manifest.name)
mkdirSync(destination, { recursive: true })
copyFileSync(join(projectDir, 'package.json'), join(destination, 'package.json'))
cpSync(join(projectDir, 'dist'), join(destination, 'dist'), { recursive: true, force: true })
if (existsSync(join(projectDir, 'docs'))) {
  cpSync(join(projectDir, 'docs'), join(destination, 'docs'), { recursive: true, force: true })
}
cpSync(join(projectDir, 'skills'), join(destination, 'skills'), { recursive: true, force: true })
for (const file of ['README.md', 'README.zh-CN.md', 'LICENSE', 'VALIDATION.md']) {
  if (existsSync(join(projectDir, file))) copyFileSync(join(projectDir, file), join(destination, file))
}
// The ESM sidecar loads Pi at runtime, outside webpack's plugin bundle.
// Use npm's JS entry to avoid Windows .cmd quoting and install only runtime dependencies.
const npmCli = process.env.npm_execpath
if (!npmCli || !existsSync(npmCli)) {
  console.error('请通过 npm run install:tabby 运行，以便安装 Pi 运行依赖。')
  process.exit(1)
}
const installed = spawnSync(process.execPath, [npmCli, 'install', '--omit=dev', '--ignore-scripts', '--package-lock=false', '--no-audit', '--no-fund'], { cwd: destination, stdio: 'inherit', shell: false })
if (installed.error || installed.status !== 0) {
  console.error('Pi 运行依赖安装失败。请修复 npm 连接后重试 install:tabby。')
  process.exit(installed.status || 1)
}
console.log(`已安装到 ${destination}`)
console.log('请完全退出并重启 Tabby，然后在设置的已安装插件中查看 AI Tools。')
