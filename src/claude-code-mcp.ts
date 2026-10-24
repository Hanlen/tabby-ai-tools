import * as http from 'http'
import { randomBytes } from 'crypto'
import type { AddressInfo } from 'net'
import type { ToolDefinition, ModelToolCall, ToolResult } from './api-provider'

/** Stateless Streamable HTTP MCP, bound only to loopback for one CLI invocation. */
export async function createClaudeMcp (tools: ToolDefinition[], call: (tool: ModelToolCall) => Promise<ToolResult>, signal: AbortSignal) {
  const token = randomBytes(32).toString('hex')
  let queue = Promise.resolve()
  const server = http.createServer(async (request, response) => {
    const send = (status: number, body?: any) => {
      if (response.destroyed) return
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(body === undefined ? undefined : JSON.stringify(body))
    }
    if (request.headers.origin || request.headers.authorization !== `Bearer ${token}` || request.url !== '/mcp') { send(403); return }
    if (request.headers.host !== `127.0.0.1:${(server.address() as AddressInfo)?.port}`) { send(403); return }
    if (request.method !== 'POST') { send(405); return }
    let message: any
    try {
      let body = ''
      request.setEncoding('utf8')
      for await (const chunk of request) {
        body += chunk
        if (Buffer.byteLength(body) > 1024 * 1024) { send(413); return }
      }
      message = JSON.parse(body)
      if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string' || Array.isArray(message)) { send(400); return }
    } catch { send(400); return }
    const id = message.id
    if (id === undefined) { send(202); return }
    const result = (value: any) => send(200, { jsonrpc: '2.0', id, result: value })
    const error = (code: number, text: string) => send(200, { jsonrpc: '2.0', id, error: { code, message: text } })
    if (signal.aborted) { error(-32000, '请求已停止'); return }
    if (message.method === 'initialize') {
      const supported = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']
      result({ protocolVersion: supported.includes(message.params?.protocolVersion) ? message.params.protocolVersion : '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'tabby', version: '1.0.0' } })
    } else if (message.method === 'ping') result({})
    else if (message.method === 'tools/list') result({ tools })
    else if (message.method === 'tools/call') {
      const definition = tools.find(tool => tool.name === message.params?.name)
      if (!definition) { error(-32602, '未知或当前策略禁止的工具'); return }
      // Serialize operations even when Claude emits parallel MCP calls.
      const operation = queue.then(async () => {
        if (signal.aborted) throw new Error('请求已停止')
        const output = await call({ id: 'claude-tool-' + randomBytes(12).toString('hex'), name: definition.name, arguments: JSON.stringify(message.params.arguments ?? {}) })
        result({ content: [{ type: 'text', text: output.result }], isError: !!output.error })
      })
      queue = operation.catch(() => undefined)
      try { await operation } catch { error(-32000, '工具执行已停止或失败') }
    } else error(-32601, 'Method not found')
  })
  server.requestTimeout = 30000
  server.headersTimeout = 10000
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() }) })
  const close = async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await queue
  }
  const config = { mcpServers: { tabby: { type: 'http', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, headers: { Authorization: `Bearer ${token}` } } } }
  return { config, close }
}
