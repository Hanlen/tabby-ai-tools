/** Error notifications have no retry deadline field; only use explicit backend text. */
export function retryDeadline (error: any, now = Date.now()): number | null {
  const text = [error?.message, error?.additionalDetails].filter(value => typeof value === 'string').join('\n')
  const match = /\b(?:retry(?:ing)?|try again)\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)\b/i.exec(text)
  if (!match) return null
  const duration = Number(match[1]) * (/^ms$|^milliseconds?/i.test(match[2]) ? 1 : /^m/i.test(match[2]) ? 60000 : 1000)
  const deadline = now + duration
  return Number.isFinite(deadline) && deadline <= 8640000000000000 ? deadline : null
}

export function retryDuration (milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000))
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

export function isRateLimitError (error: any): boolean {
  const info = error?.codexErrorInfo
  const http429 = info && typeof info === 'object' && Object.values(info).some((value: any) => value?.httpStatusCode === 429)
  return !!http429 || info === 'rateLimitExceeded' || info === 'usageLimitExceeded' ||
    /usage.?limit|rate.?limit|quota|too many requests|\b429\b|用量.*上限|额度.*(耗尽|用完|上限)/i.test(String(error?.message || ''))
}
