import * as http from 'http'
import * as https from 'https'

export function withAbort<T> (operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('请求已取消或超时'))
    signal.addEventListener('abort', abort, { once: true })
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    if (signal.aborted) abort()
  })
}

export function apiUrl (baseUrl: string, path: string): URL {
  if (!baseUrl?.trim()) throw new Error('请填写 API Base URL')
  const url = new URL(baseUrl.replace(/\/+$/, '') + '/' + path)
  if (url.username || url.password || url.search || url.hash) throw new Error('API Base URL 不能包含凭据、查询参数或片段')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('API 地址需要 HTTPS；仅本地回环地址允许 HTTP')
  }
  return url
}

/** Bounded JSON GET using the same Node transport and redirect policy as streaming. */
export async function getApiJson (url: URL, headers: Record<string, string>, signal: AbortSignal): Promise<any> {
  if (signal.aborted) throw new Error('请求已取消或超时')
  const request = (url.protocol === 'https:' ? https : http).request(url, {
    method: 'GET', headers: { ...headers, accept: 'application/json', 'accept-encoding': 'identity' },
  })
  const abort = () => request.destroy(new Error('请求已取消或超时'))
  signal.addEventListener('abort', abort, { once: true })
  request.setTimeout(30000, () => request.destroy(new Error('获取模型列表超时')))
  try {
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      request.once('response', resolve)
      request.once('error', reject)
      request.end()
    })
    if (response.statusCode !== 200) {
      response.destroy()
      const reason = ({ 401: '密钥无效', 403: '没有访问权限', 404: '此端点未提供模型列表，请手动填写模型 ID', 405: '此端点不支持获取模型列表，请手动填写模型 ID', 429: '请求过于频繁，请稍后重试' } as Record<number, string>)[response.statusCode || 0] || '获取模型列表失败'
      throw new Error(`API HTTP ${response.statusCode}：${reason}`)
    }
    const chunks: Buffer[] = []
    let received = 0
    for await (const chunk of response) {
      received += chunk.length
      if (received > 2 * 1024 * 1024) throw new Error('模型列表超过大小限制')
      chunks.push(chunk)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { throw new Error('API 未返回有效的模型列表 JSON，请检查端点或代理') }
  } finally {
    signal.removeEventListener('abort', abort)
    request.destroy()
  }
}

/** Node transport: no renderer fetch/CORS dependency, no credential-bearing redirects. */
export async function * streamApi (url: URL, headers: Record<string, string>, body: any, signal: AbortSignal): AsyncGenerator<any> {
  if (signal.aborted) throw new Error('请求已停止')
  const wire = JSON.stringify(body)
  const request = (url.protocol === 'https:' ? https : http).request(url, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json', accept: 'text/event-stream', 'accept-encoding': 'identity', 'cache-control': 'no-cache' },
  })
  const abort = () => request.destroy(new Error('请求已停止'))
  signal.addEventListener('abort', abort, { once: true })
  request.setTimeout(120000, () => request.destroy(new Error('API 响应超时')))
  const deadline = setTimeout(() => request.destroy(new Error('API 请求超过十分钟')), 600000)
  try {
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      request.once('response', resolve)
      request.once('error', reject)
      request.end(wire)
    })
    if (response.statusCode !== 200) {
      // Provider error bodies may echo request contents. Keep credentials and prompts out of errors.
      response.destroy()
      throw new Error(`API HTTP ${response.statusCode}：${({ 400: '请求参数不兼容，请检查模型、Thinking 和输出上限', 401: '密钥无效', 403: '没有访问权限', 404: '检查端点与模型 ID', 429: '额度不足或请求过于频繁' } as Record<number, string>)[response.statusCode || 0] || '服务请求失败'}`)
    }
    if (!String(response.headers['content-type'] || '').toLowerCase().includes('text/event-stream')) {
      response.destroy()
      throw new Error('API 未返回 SSE 流式响应，请检查端点或代理的流式支持')
    }
    response.setEncoding('utf8')
    let buffer = ''
    let received = 0
    for await (const chunk of response) {
      received += chunk.length
      if (received > 8 * 1024 * 1024) throw new Error('API 回复超过大小限制')
      buffer += chunk
      if (buffer.length > 4 * 1024 * 1024) throw new Error('API 流事件超过大小限制')
      let boundary: RegExpExecArray | null
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary[0].length)
        const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (!data) continue
        if (data === '[DONE]') return
        const event = JSON.parse(data)
        if (event.error || event.type === 'error') throw new Error('模型 API 返回错误，请检查配置或稍后重试')
        yield event
      }
    }
    if (buffer.trim() && !buffer.trim().startsWith(':')) throw new Error('API 流意外结束，事件不完整')
  } finally {
    clearTimeout(deadline)
    signal.removeEventListener('abort', abort)
    request.destroy()
  }
}
