/** Authentication errors can arrive as RPC failures or structured turn errors. */
export function isNativeAuthenticationError (error: any): boolean {
  const visit = (value: any, depth: number): boolean => {
    if (!value || depth > 5) return false
    if (typeof value === 'string') return /\b401\b|\bunauthorized\b|not logged in|\b(?:token_expired|refresh_token_(?:expired|reused|invalidated)|authentication_(?:required|failed|error))\b|(?:access|refresh|authentication|auth)[ _-]*token[^\n]{0,80}(?:expired|invalid|revoked|reused)|(?:expired|invalid|revoked)[ _-]*(?:access|refresh|authentication|auth)[ _-]*token/i.test(value)
    if (typeof value !== 'object') return false
    if (Array.isArray(value)) return value.some(item => visit(item, depth + 1))
    for (const key of ['httpStatusCode', 'http_status_code', 'status', 'statusCode', 'code']) {
      if (value[key] === 401 || value[key] === '401') return true
    }
    return ['message', 'additionalDetails', 'code', 'error', 'errors', 'result', 'codexErrorInfo', 'responseStreamDisconnected', 'httpConnectionFailed', 'responseTooManyFailedAttempts']
      .some(key => visit(value[key], depth + 1))
  }
  return visit(error, 0)
}
