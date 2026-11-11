export type McpClientKind = 'codex' | 'cursor' | 'claude'
/** Copy-only preview. Never reads, merges or writes a user's client configuration. */
export function mcpClientConfig (kind: McpClientKind, endpoint: string, token: string): string {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(endpoint) || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('MCP configuration is unavailable')
  const authorization = 'Bearer ' + token
  if (kind === 'codex') return `[mcp_servers.tabby]\nurl = ${JSON.stringify(endpoint)}\nhttp_headers = { Authorization = ${JSON.stringify(authorization)} }\n`
  if (kind !== 'cursor' && kind !== 'claude') throw new Error('Unknown MCP client')
  return JSON.stringify({ mcpServers: { tabby: { ...(kind === 'claude' ? { type: 'http' } : {}), url: endpoint, headers: { Authorization: authorization } } } }, null, 2) + '\n'
}
