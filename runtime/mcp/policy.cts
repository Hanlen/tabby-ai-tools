import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync, lstatSync, chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export const failure = (code: string) => Object.assign(new Error(code), { code })
export const randomId = () => randomBytes(24).toString('base64url')
export const tokenDigest = (value: string) => createHash('sha256').update(value).digest('hex')
export interface ClientGrant { id: string; name: string; digest: string; revision: number; targets: Set<string>; lastSeen?: string }
export interface Target { id: string; owner: number; key: string; session: string; title: string }
export class McpPolicy {
  enabled = false
  port = 0
  clients = new Map<string, ClientGrant>()
  targets = new Map<string, Target>()
  private file: string
  constructor (directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (lstatSync(directory).isSymbolicLink()) throw new Error('MCP state directory must not be a symlink')
    if (process.platform !== 'win32') chmodSync(directory, 0o700)
    this.file = join(directory, 'state.json')
    try {
      if (lstatSync(this.file).isSymbolicLink()) throw new Error('MCP state must not be a symlink')
      if (lstatSync(this.file).size > 128 * 1024) throw new Error('MCP state exceeds size limit')
      if (process.platform !== 'win32') chmodSync(this.file, 0o600)
      const data = JSON.parse(readFileSync(this.file, 'utf8'))
      if (data.version !== 1 || !Array.isArray(data.clients) || data.clients.length > 32 || !Number.isInteger(data.port) || data.port < 0 || data.port > 65535) throw new Error('Invalid MCP state')
      this.enabled = data.enabled === true; this.port = data.port
      for (const item of data.clients) {
        if (typeof item.id !== 'string' || !/^[a-f0-9]{64}$/.test(item.digest) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 80 || !Number.isSafeInteger(item.revision) || item.revision < 1) throw new Error('Invalid MCP client state')
        // A saved terminal name is never sufficient to restore access after restart.
        this.clients.set(item.id, { ...item, targets: new Set(), revision: item.revision + 1, lastSeen: undefined })
      }
    } catch (error: any) { if (error.code !== 'ENOENT') throw error }
  }
  save (): void {
    const temporary = this.file + '.' + randomId() + '.tmp'
    const data = { version: 1, enabled: this.enabled, port: this.port, clients: [...this.clients.values()].map(({ id, name, digest, revision }) => ({ id, name, digest, revision })) }
    try {
      writeFileSync(temporary, JSON.stringify(data) + '\n', { mode: 0o600, flag: 'wx' })
      renameSync(temporary, this.file)
    } finally { rmSync(temporary, { force: true }) }
  }
  add (name: string): { id: string; token: string } {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) throw new Error('Client name must contain 1–80 characters')
    if (this.clients.size >= 32) throw new Error('At most 32 MCP clients are allowed')
    const id = randomId(), token = randomBytes(32).toString('base64url')
    this.clients.set(id, { id, name: name.trim(), digest: tokenDigest(token), revision: 1, targets: new Set() })
    return { id, token }
  }
  rotate (id: string): { id: string; token: string } {
    const client = this.client(id), token = randomBytes(32).toString('base64url')
    client.digest = tokenDigest(token); client.revision++; client.lastSeen = undefined
    return { id, token }
  }
  client (id: string): ClientGrant {
    const client = this.clients.get(id)
    if (!client) throw failure('permission_denied')
    return client
  }
  setScope (id: string, targetIds: string[]): void {
    if (!Array.isArray(targetIds) || targetIds.length > 256 || targetIds.some(id => typeof id !== 'string' || !this.targets.has(id))) throw failure('target_stale')
    const client = this.client(id)
    client.targets = new Set(targetIds); client.revision++
  }
  removeTarget (id: string): void {
    this.targets.delete(id)
    for (const client of this.clients.values()) if (client.targets.delete(id)) client.revision++
  }
  register (owner: number, entries: { key: string; session: string; title: string }[]): void {
    if (!Array.isArray(entries) || entries.length > 256 || entries.some(t => !t || typeof t.key !== 'string' || t.key.length > 128 || typeof t.session !== 'string' || t.session.length > 128 || typeof t.title !== 'string' || t.title.length > 200)) throw new Error('Invalid terminal registration')
    if (new Set(entries.map(t => t.key)).size !== entries.length) throw new Error('Duplicate terminal key')
    for (const target of [...this.targets.values()]) if (target.owner === owner && !entries.some(e => e.key === target.key && e.session === target.session)) this.removeTarget(target.id)
    for (const entry of entries) {
      const current = [...this.targets.values()].find(t => t.owner === owner && t.key === entry.key && t.session === entry.session)
      if (current) current.title = entry.title
      else { const id = randomId(); this.targets.set(id, { ...entry, id, owner }) }
    }
  }
  removeOwner (owner: number): void { for (const target of [...this.targets.values()]) if (target.owner === owner) this.removeTarget(target.id) }
  authorize (id: string, revision: number, targetId?: string): ClientGrant {
    const client = this.client(id)
    if (!this.enabled || client.revision !== revision) throw failure('permission_denied')
    if (targetId && (!client.targets.has(targetId) || !this.targets.has(targetId))) throw failure('permission_denied')
    return client
  }
  snapshot () { return { enabled: this.enabled, clients: [...this.clients.values()].map(c => ({ id: c.id, digest: c.digest, revision: c.revision })) } }
  publicState () {
    return { enabled: this.enabled, clients: [...this.clients.values()].map(c => ({ id: c.id, name: c.name, revision: c.revision, targets: [...c.targets], lastSeen: c.lastSeen })), targets: [...this.targets.values()].map(t => ({ id: t.id, title: t.title, window: t.owner })) }
  }
}
