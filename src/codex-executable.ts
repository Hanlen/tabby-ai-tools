import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const SETTING_HELP = '请在 Tabby Settings → AI Tools → Codex CLI 可执行文件（codexAgent.executable）中设置有效文件路径或命令名。'
const WINDOWS_EXTENSIONS = ['.exe', '.com', '.cmd', '.bat']

export interface ExecutableContext {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  cwd?: string
  home?: string
  /** Allows filesystem-backed Windows discovery simulations on other hosts. */
  paths?: path.PlatformPath
}

export function environmentValue (env: NodeJS.ProcessEnv, name: string, windows: boolean): string | undefined {
  const key = windows ? Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase()) : name
  return key ? env[key] : undefined
}

export function codexEnvironment (inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(inherited).filter(([key]) => key.toUpperCase() !== 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE'))
}

export function normalizeExecutable (value: string): string {
  const trimmed = (value || '').trim()
  return /^(["']).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed
}

export function executableFile (filename: string, context: ExecutableContext = {}): fs.Stats {
  const windows = (context.platform || process.platform) === 'win32'
  const paths = context.paths || (windows ? path.win32 : path.posix)
  const stat = fs.statSync(filename)
  if (!stat.isFile()) throw new Error('不是普通文件')
  if (windows && !WINDOWS_EXTENSIONS.includes(paths.extname(filename).toLowerCase())) {
    throw new Error('Windows 仅支持 .exe / .com / .cmd / .bat 文件')
  }
  fs.accessSync(filename, windows ? fs.constants.R_OK : fs.constants.X_OK)
  return stat
}

/** Windows environment keys are case insensitive; never introduce a second PATH. */
export function executableEnvironment (env: NodeJS.ProcessEnv, searchPath: string, windows: boolean): NodeJS.ProcessEnv {
  const result = { ...env }
  if (windows) for (const key of Object.keys(result)) if (key.toUpperCase() === 'PATH') delete result[key]
  result.PATH = searchPath
  return result
}

/** Resolve on each new connection: desktop installs use changing, opaque directory names. */
export function resolveCodexExecutable (configured: string, context: ExecutableContext = {}): string {
  const windows = (context.platform || process.platform) === 'win32'
  const paths = context.paths || (windows ? path.win32 : path.posix)
  const env = context.env || process.env
  const cwd = context.cwd || process.cwd()
  let value = normalizeExecutable(configured)
  if (/^~[/\\]/.test(value)) value = paths.join(context.home || os.homedir(), value.slice(2))
  const automatic = !value || value === 'codex'
  const reasons: string[] = []
  const validFile = (filename: string): fs.Stats => executableFile(filename, context)
  const fail = (message: string): never => { throw new Error(`${message}\n${reasons.join('\n')}\n${SETTING_HELP}`) }
  if (value && (paths.isAbsolute(value) || /[/\\]/.test(value) || (windows && /^[a-z]:/i.test(value)))) {
    const filename = paths.resolve(cwd, value)
    try { validFile(filename) } catch (error: any) {
      reasons.push(`${filename}: ${error.code || error.message}`)
      return fail('显式配置的 Codex CLI 路径无效；未尝试自动查找。')
    }
    return filename
  }

  const command = value || 'codex'
  const pathValue = environmentValue(env, 'PATH', windows)
  const extensions = windows && !paths.extname(command)
    ? (environmentValue(env, 'PATHEXT', true) || '.COM;.EXE;.BAT;.CMD').split(';')
      .map(ext => ext.toLowerCase()).filter(ext => WINDOWS_EXTENSIONS.includes(ext))
    : ['']
  const entries = (pathValue || '').split(windows ? ';' : ':').filter(entry => entry.trim())
  for (const entry of entries) {
    const directory = normalizeExecutable(entry)
    for (const extension of extensions) {
      const filename = paths.resolve(cwd, directory, command + extension)
      try { validFile(filename); return filename } catch (error: any) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') reasons.push(`${filename}: ${error.code || error.message}`)
      }
    }
  }
  reasons.unshift(`PATH: ${pathValue ? `已检查 ${entries.length} 个目录，没有可用的 ${command}` : '未设置或为空'}${windows ? `；PATHEXT=${extensions.join(';')}` : ''}`)
  if (!automatic) return fail(`配置的 Codex CLI 命令 ${command} 无法从 PATH 定位；未尝试其他安装。`)

  const installDir = environmentValue(env, 'CODEX_INSTALL_DIR', windows)
  if (installDir) {
    const directory = normalizeExecutable(installDir)
    const expanded = /^~[/\\]/.test(directory) ? paths.join(context.home || os.homedir(), directory.slice(2)) : directory
    const filename = paths.resolve(cwd, expanded, windows ? 'codex.exe' : 'codex')
    try { validFile(filename); return filename } catch (error: any) {
      reasons.push(`CODEX_INSTALL_DIR ${filename}: ${error.code || error.message}`)
    }
  }

  if (windows) {
    const localAppData = environmentValue(env, 'LOCALAPPDATA', true)
    if (!localAppData) reasons.push('LOCALAPPDATA: 未设置，无法扫描 OpenAI/Codex/bin')
    else {
      const standalone = paths.resolve(cwd, localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')
      try { validFile(standalone); return standalone } catch (error: any) {
        reasons.push(`独立安装 ${standalone}: ${error.code || error.message}`)
      }
    }
    const home = context.home || environmentValue(env, 'USERPROFILE', true) || os.homedir()
    const codexHome = normalizeExecutable(environmentValue(env, 'CODEX_HOME', true) || paths.join(home, '.codex'))
    const expandedHome = /^~[/\\]/.test(codexHome) ? paths.join(home, codexHome.slice(2)) : codexHome
    for (const suffix of [['bin', 'codex.exe'], ['codex.exe']]) {
      const filename = paths.resolve(cwd, expandedHome, 'packages', 'standalone', 'current', ...suffix)
      try { validFile(filename); return filename } catch (error: any) { reasons.push(`standalone ${filename}: ${error.code || error.message}`) }
    }
    if (localAppData) {
      const root = paths.resolve(cwd, localAppData, 'OpenAI', 'Codex', 'bin')
      const candidates: { filename: string; mtime: number }[] = []
      try {
        for (const directory of fs.readdirSync(root)) {
          const folder = paths.join(root, directory)
          const filename = paths.join(folder, 'codex.exe')
          try {
            if (!fs.statSync(folder).isDirectory()) continue
            candidates.push({ filename, mtime: validFile(filename).mtimeMs })
          } catch (error: any) { reasons.push(`${filename}: ${error.code || error.message}`) }
        }
        // Directory names are opaque hashes, never semantic versions. Stable path
        // ordering is only a tie breaker when executable modification times match.
        candidates.sort((a, b) => b.mtime - a.mtime || (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0))
        if (candidates.length) return candidates[0].filename
        reasons.push(`${root}: 没有可用的 <目录>/codex.exe`)
      } catch (error: any) { reasons.push(`${root}: ${error.code || error.message}`) }
    }
  }
  return fail('找不到 Codex CLI。')
}
