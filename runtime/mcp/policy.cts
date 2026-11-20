import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync, lstatSync, chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export const failure = (code: string) => Object.assign(new Error(code), { code })
export const randomId = () => randomBytes(24).toString('base64url')
export const tokenDigest = (value: string) => createHash('sha256').update(value).digest('hex')
export const LOCAL_CLIENT_ID = 'local'
export type McpMode = 'read_only' | 'confirm' | 'auto'
export interface ClientGrant { mode: McpMode; id: string; name: string; digest: string; revision: number; targets: Set<string>; lastSeen?: string }
export interface Target { id: string; owner: number; key: string; session: string; title: string; connected?: boolean }
export class McpPolicy {
  enabled = false
  port = 0
  clients = new Map<string, ClientGrant>()
  targets = new Map<string, Target>()
  private file: string
  constructor (directory: string) {
    // Headerless loopback requests share automatic access to every live terminal.
    // Bearer clients keep their own independently selected grants.
    this.clients.set(LOCAL_CLIENT_ID, { id: LOCAL_CLIENT_ID, name: 'Local connection (no token)', digest: '', revision: 1, mode: 'auto', targets: new Set() })
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
        if (typeof item.id !== 'string' || item.id === LOCAL_CLIENT_ID || !/^[a-f0-9]{64}$/.test(item.digest) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 80 || !Number.isSafeInteger(item.revision) || item.revision < 1) throw new Error('Invalid MCP client state')
        // A saved terminal name is never sufficient to restore access after restart.
        this.clients.set(item.id, { ...item, targets: new Set(), mode: 'read_only', revision: item.revision + 1, lastSeen: undefined })
      }
    } catch (error: any) { if (error.code !== 'ENOENT') throw error }
  }
  save (): void {
    const temporary = this.file + '.' + randomId() + '.tmp'
    const data = { version: 1, enabled: this.enabled, port: this.port, clients: [...this.clients.values()].filter(c => c.id !== LOCAL_CLIENT_ID).map(({ id, name, digest, revision }) => ({ id, name, digest, revision })) }
    try {
      writeFileSync(temporary, JSON.stringify(data) + '\n', { mode: 0o600, flag: 'wx' })
      renameSync(temporary, this.file)
    } finally { rmSync(temporary, { force: true }) }
  }
  add (name: string): { id: string; token: string } {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) throw new Error('Client name must contain 1–80 characters')
    if (this.clients.size >= 33) throw new Error('At most 32 MCP clients are allowed')
    const id = randomId(), token = randomBytes(32).toString('base64url')
    this.clients.set(id, { id, name: name.trim(), digest: tokenDigest(token), revision: 1, mode: 'read_only', targets: new Set() })
    return { id, token }
  }
  rotate (id: string): { id: string; token: string } {
    if (id === LOCAL_CLIENT_ID) throw new Error('The local connection does not use a token')
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
    if (id === LOCAL_CLIENT_ID) throw failure('permission_denied')
    if (!Array.isArray(targetIds) || targetIds.length > 256 || targetIds.some(id => typeof id !== 'string' || !this.targets.has(id) || this.targets.get(id)?.connected === false)) throw failure('target_stale')
    const client = this.client(id)
    client.targets = new Set(targetIds); client.revision++
  }
  setMode (id: string, mode: McpMode): void {
    if (id === LOCAL_CLIENT_ID) throw failure('permission_denied')
    if (!['read_only', 'confirm', 'auto'].includes(mode)) throw failure('permission_denied')
    const client = this.client(id)
    client.mode = mode; client.revision++
  }
  removeTarget (id: string): void {
    this.targets.delete(id)
    // A removed opaque target already fails authorization. Do not invalidate
    // unrelated local observations/leases when another tab closes or reconnects.
    for (const client of this.clients.values()) if (client.targets.delete(id) && client.id !== LOCAL_CLIENT_ID) client.revision++
  }
  register (owner: number, entries: { key: string; session: string; title: string; connected?: boolean }[]): void {
    if (!Array.isArray(entries) || entries.length > 256 || entries.some(t => !t || typeof t.key !== 'string' || t.key.length > 128 || typeof t.session !== 'string' || t.session.length > 128 || typeof t.title !== 'string' || t.title.length > 200 || t.connected !== undefined && typeof t.connected !== 'boolean')) throw new Error('Invalid terminal registration')
    if (new Set(entries.map(t => t.key)).size !== entries.length) throw new Error('Duplicate terminal key')
    for (const target of [...this.targets.values()]) if (target.owner === owner && !entries.some(e => e.key === target.key && e.session === target.session && (e.connected === false) === (target.connected === false))) this.removeTarget(target.id)
    for (const entry of entries) {
      const current = [...this.targets.values()].find(t => t.owner === owner && t.key === entry.key && t.session === entry.session)
      if (current) current.title = entry.title
      else {
        const id = randomId()
        this.targets.set(id, { ...entry, id, owner })
        this.client(LOCAL_CLIENT_ID).targets.add(id)
      }
    }
  }
  removeOwner (owner: number): void { for (const target of [...this.targets.values()]) if (target.owner === owner) this.removeTarget(target.id) }
  authorize (id: string, revision: number, targetId?: string): ClientGrant {
    const client = this.client(id)
    if (!this.enabled || client.revision !== revision) throw failure('permission_denied')
    if (targetId && (!client.targets.has(targetId) || !this.targets.has(targetId))) throw failure('permission_denied')
    return client
  }
  snapshot () { return { enabled: this.enabled, clients: [...this.clients.values()].map(c => ({ id: c.id, digest: c.digest, revision: c.revision, mode: c.mode })) } }
  publicState () {
    const view = (c: ClientGrant) => ({ id: c.id, name: c.name, mode: c.mode, revision: c.revision, targets: [...c.targets], lastSeen: c.lastSeen })
    return { enabled: this.enabled, localClient: view(this.client(LOCAL_CLIENT_ID)), clients: [...this.clients.values()].filter(c => c.id !== LOCAL_CLIENT_ID).map(view), targets: [...this.targets.values()].filter(t => t.connected !== false).map(t => ({ id: t.id, title: t.title, window: t.owner })) }
  }
}
