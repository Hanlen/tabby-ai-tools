import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, rmdirSync } from 'node:fs'
import { randomId } from './policy.cjs'

/** Credential-free bootstrap, independent of MCP authentication and permissions. */
export class McpDiscovery {
  readonly registry: string
  readonly profile: string
  private last = ''
  constructor (private home: string, configSpace: string, private skillSource: string, private version: string) {
    this.registry = join(home, '.agents', 'tabby', 'mcp')
    this.profile = createHash('sha256').update(configSpace).digest('hex').slice(0, 24)
  }
  private directory (path: string): void {
    mkdirSync(path, { recursive: true, mode: 0o700 })
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw new Error('Discovery directory is not a regular directory')
  }
  installSkill (): { path: string; status: 'installed' | 'present' | 'conflict' | 'error' }[] {
    const roots = [join(this.home, '.agents', 'skills')]
    for (const client of ['.claude']) if (existsSync(join(this.home, client))) roots.push(join(this.home, client, 'skills'))
    const files: Record<string, string> = {
      'SKILL.md': readFileSync(join(this.skillSource, 'SKILL.md'), 'utf8'),
      'references/connection.md': readFileSync(join(this.skillSource, 'references/connection.md'), 'utf8'),
      'references/local-discovery.json': JSON.stringify({ format: 'tabby-mcp-locator-v1', registry: this.registry, credentialsIncluded: false }, null, 2) + '\n',
    }
    return roots.map(root => {
      const destination = join(root, 'tabby-mcp'), created: string[] = []
      let own = false
      try {
        this.directory(root)
        if (existsSync(destination) || (() => { try { lstatSync(destination); return true } catch { return false } })()) {
          const plain = lstatSync(destination).isDirectory() && !lstatSync(destination).isSymbolicLink()
          const matching = plain && existsSync(join(destination, 'references')) && !lstatSync(join(destination, 'references')).isSymbolicLink() && Object.entries(files).every(([file, text]) => {
            try { const path = join(destination, file); return !lstatSync(path).isSymbolicLink() && readFileSync(path, 'utf8') === text } catch { return false }
          })
          return { path: destination, status: matching ? 'present' as const : 'conflict' as const }
        }
        // Exclusive directory creation arbitrates concurrent windows/processes.
        mkdirSync(destination, { mode: 0o700 }); own = true
        mkdirSync(join(destination, 'references'), { mode: 0o700 })
        // Publish the skill manifest last, after its supporting files exist.
        for (const file of ['references/connection.md', 'references/local-discovery.json', 'SKILL.md']) {
          const path = join(destination, file)
          writeFileSync(path, files[file], { mode: 0o600, flag: 'wx' }); created.push(file)
        }
        return { path: destination, status: 'installed' as const }
      } catch {
        // Preserve any concurrent/user edits; only remove bytes created here.
        if (own) for (const file of created) {
          const path = join(destination, file)
          try { if (!lstatSync(path).isSymbolicLink() && readFileSync(path, 'utf8') === files[file]) rmSync(path) } catch { /* Leave for local inspection. */ }
        }
        if (own) { try { rmdirSync(join(destination, 'references')) } catch { /* Nonempty/user paths are preserved. */ }; try { rmdirSync(destination) } catch { /* Never recursively delete a conflict. */ } }
        return { path: destination, status: 'error' as const }
      }
    })
  }
  update (state: { enabled: boolean; running: boolean; endpoint: string }): void {
    const status = state.running ? 'running' : state.enabled ? 'unavailable' : 'disabled'
    const payload = { format: 'tabby-mcp-discovery-v1', profile: this.profile, application: 'Tabby AI Tools', version: this.version, status, endpoint: state.running ? state.endpoint : '', authentication: 'independent_client_bearer', credentialsIncluded: false, setup: 'Tabby > Settings > AI Tools > External AI connections (MCP)', skill: 'tabby-mcp' }
    if (payload.endpoint && !/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(payload.endpoint)) throw new Error('Invalid discovery endpoint')
    const value = JSON.stringify(payload)
    if (this.last === value && existsSync(join(this.registry, this.profile + '.json'))) return
    this.directory(this.registry)
    // Separate files prevent configuration spaces from overwriting one another.
    const target = join(this.registry, this.profile + '.json'), temporary = target + '.' + randomId() + '.tmp'
    try {
      if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error('Discovery record must not be a symlink')
      writeFileSync(temporary, JSON.stringify({ ...payload, updatedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
      renameSync(temporary, target); this.last = value
    } finally { rmSync(temporary, { force: true }) }
  }
}
