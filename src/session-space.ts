import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createHash, randomBytes } from 'crypto'
import type { AgentSettings } from './config'
import { environmentValue, normalizeExecutable } from './codex-executable'

export type NativeEngine = 'codex' | 'claude-code'
export type SessionSpaceConfig = { mode: 'system' } | { mode: 'tabby'; spaceId: string }
export interface NativeSessionSpace {
  engine: NativeEngine
  key: string
  root?: string
  native?: string
}
const codexCredentialKeys = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN']
const claudeCredentialKeys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']

/** Missing settings preserve existing native references, while unused engines
 * start private. IDs depend on connection identity, never display names/cwd. */
export function sessionSpaceConfig (settings: AgentSettings, engine: NativeEngine): SessionSpaceConfig {
  const configured = settings.cliSessionSpaces?.[engine]
  if (configured) {
    if (configured.mode === 'system') return { mode: 'system' }
    if (configured.mode !== 'tabby' || !/^[a-f0-9]{32}$/.test(configured.spaceId)) throw new Error('Invalid session space configuration')
    return { mode: 'tabby', spaceId: configured.spaceId }
  }
  const references = engine === 'codex' ? { ...settings.threads, ...settings.tabToolThreads } : settings.claudeThreads
  if (Object.values(references || {}).some(value => typeof value === 'string' && value)) return { mode: 'system' }
  return privateSpaceConfig(engine)
}

export function privateSpaceConfig (engine: NativeEngine): SessionSpaceConfig {
  return { mode: 'tabby', spaceId: createHash('sha256').update('tabby-ai-tools:space:v1:' + engine).digest('hex').slice(0, 32) }
}

export function resolveSessionSpace (dataRoot: string | undefined, engine: NativeEngine, config: SessionSpaceConfig): NativeSessionSpace {
  if (config.mode === 'system') return { engine, key: 'system:' + engine }
  if (!dataRoot) throw new Error('Cannot locate the Tabby data directory for private sessions')
  if (!/^[a-f0-9]{32}$/.test(config.spaceId)) throw new Error('Invalid session space ID')
  const root = path.join(dataRoot, 'spaces', config.spaceId)
  return { engine, key: config.spaceId, root, native: path.join(root, 'native') }
}

export async function prepareSessionSpace (space: NativeSessionSpace): Promise<void> {
  if (!space.root || !space.native) return
  await fs.mkdir(space.root, { recursive: true, mode: 0o700 })
  if ((await fs.lstat(space.root)).isSymbolicLink()) throw new Error('Private session directories must not link to another space')
  await fs.mkdir(space.native, { recursive: true, mode: 0o700 })
  if ((await fs.lstat(space.native)).isSymbolicLink()) throw new Error('Private session directories must not link to another space')
  const manifest = { version: 1, engine: space.engine, spaceId: space.key }
  const file = path.join(space.root, 'manifest.json')
  try { await fs.writeFile(file, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 }) } catch (error: any) {
    if (error.code !== 'EEXIST') throw error
    const saved = JSON.parse(await fs.readFile(file, 'utf8'))
    if (saved.version !== 1 || saved.engine !== space.engine || saved.spaceId !== space.key) throw new Error('Session space belongs to another connection')
  }
}

/** Seed an unconfigured private home from the official CLI's login cache.
 * Publish a complete owner-only file; only explicit recovery replaces a login.
 * Source credentials and native history are never changed or logged. */
export async function initializeNativeAuth (space: NativeSessionSpace | undefined, inherited: NodeJS.ProcessEnv, options: { home?: string; replaceExisting?: boolean } = {}): Promise<boolean> {
  if (!space?.native) return false
  const codex = space.engine === 'codex'
  const filename = codex ? 'auth.json' : '.credentials.json'
  const home = options.home || os.homedir()
  const target = path.join(space.native, filename)
  try {
    if (!options.replaceExisting) {
      try { await fs.lstat(target); return false } catch (error: any) { if (error.code !== 'ENOENT') throw error }
    }
    let sourceHome = normalizeExecutable(environmentValue(inherited, codex ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR', process.platform === 'win32') || path.join(home, codex ? '.codex' : '.claude'))
    if (/^~[/\\]/.test(sourceHome)) sourceHome = path.join(home, sourceHome.slice(2))
    let cache: string
    try { cache = await fs.readFile(path.join(sourceHome, filename), 'utf8') }
    catch (error: any) { if (error.code === 'ENOENT') return false; throw error }
    let auth: any
    try { auth = JSON.parse(cache) } catch { return false }
    // API-key-only caches must not silently change subscription billing.
    if (!auth) return false
    if (codex ? (auth.auth_mode && auth.auth_mode !== 'chatgpt') || typeof auth.tokens?.access_token !== 'string' || !auth.tokens.access_token
      : typeof auth.claudeAiOauth?.accessToken !== 'string' || !auth.claudeAiOauth.accessToken) return false
    const temporary = path.join(space.native, `.auth-${randomBytes(16).toString('hex')}.tmp`)
    const handle = await fs.open(temporary, 'wx', 0o600)
    try {
      try { await handle.writeFile(cache) } finally { await handle.close() }
      if (options.replaceExisting) { await fs.rename(temporary, target); return true }
      try { await fs.link(temporary, target); return true }
      catch (error: any) { if (error.code === 'EEXIST') return false; throw error }
    } finally {
      try { await fs.unlink(temporary) } catch (error: any) { if (error.code !== 'ENOENT') throw error }
    }
  } catch (error: any) {
    // Do not include parser errors or file contents in a diagnostic.
    throw new Error(`Cannot initialize CLI login cache (${error.code || 'file error'}). Check selected-space login.`)
  }
}

export function sessionEnvironment (space: NativeSessionSpace | undefined, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...inherited }
  if (!space?.native) return env
  const owned = space.engine === 'codex' ? ['CODEX_HOME', 'CODEX_SQLITE_HOME', ...codexCredentialKeys] : ['CLAUDE_CONFIG_DIR', ...claudeCredentialKeys]
  for (const key of Object.keys(env)) if (owned.includes(key.toUpperCase())) delete env[key]
  if (space.engine === 'codex') { env.CODEX_HOME = space.native; env.CODEX_SQLITE_HOME = space.native }
  else env.CLAUDE_CONFIG_DIR = space.native
  return env
}

export function codexSpaceArgs (space?: NativeSessionSpace): string[] {
  return space?.native ? ['-c', 'sqlite_home=' + JSON.stringify(space.native), '-c', 'log_dir=' + JSON.stringify(path.join(space.native, 'logs')), '-c', 'cli_auth_credentials_store="file"'] : []
}

export function spaceThreads (settings: AgentSettings, engine: NativeEngine, space: NativeSessionSpace): Record<string, string> {
  if (!space.native) return engine === 'codex' ? settings.threads ||= {} : settings.claudeThreads ||= {}
  settings.spaceThreads ||= {}
  return settings.spaceThreads[space.key] ||= {}
}

/** Display/copy only. This string is never evaluated by the plugin. */
export function nativeLoginCommand (space: NativeSessionSpace, executable: string, windows = process.platform === 'win32'): string {
  const args = space.engine === 'codex' ? [...codexSpaceArgs(space), 'login', '--device-auth'] : ['auth', 'login']
  const quote = (value: string): string => windows ? "'" + value.replace(/'/g, "''") + "'" : "'" + value.replace(/'/g, "'\\''") + "'"
  const env = sessionEnvironment(space, {})
  const clear = space.native ? space.engine === 'codex' ? codexCredentialKeys : claudeCredentialKeys : []
  const command = [quote(executable), ...args.map(quote)].join(' ')
  if (windows) {
    const keys = [...clear, ...Object.keys(env)].map(quote).join(', ')
    const setup = [...clear.map(key => `Remove-Item Env:${key} -ErrorAction SilentlyContinue`), ...Object.entries(env).map(([key, value]) => `$env:${key} = ${quote(value!)}`), '& ' + command].join('\n')
    return `& {\n$tabbyLoginEnv = @{}\n$tabbyLoginKeys = @(${keys})\nforeach ($tabbyLoginKey in $tabbyLoginKeys) { $tabbyLoginEnv[$tabbyLoginKey] = [Environment]::GetEnvironmentVariable($tabbyLoginKey, 'Process') }\ntry {\n${setup}\n} finally {\nforeach ($tabbyLoginKey in $tabbyLoginKeys) { [Environment]::SetEnvironmentVariable($tabbyLoginKey, $tabbyLoginEnv[$tabbyLoginKey], 'Process') }\n}\n}`
  }
  return 'env ' + [...clear.flatMap(key => ['-u', key]), ...Object.entries(env).map(([key, value]) => key + '=' + quote(value!))].join(' ') + ' ' + command
}
