interface ErrorLike {
  name?: unknown
  message?: unknown
  statusCode?: unknown
  isRetryable?: unknown
}

const FULL_SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bBasic\s+[A-Za-z0-9+/=]+/gi
]

const PREFIXED_SECRET_PATTERNS = [
  /([?&](?:api[_-]?key|token|secret|password)=)[^&#\s]+/gi,
  /((?:api[_-]?key|authorization|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi
]

export function formatSafeError(error: unknown): string {
  if (!error || typeof error !== 'object') return 'An unknown stream error occurred.'
  const value = error as ErrorLike
  const statusCode = typeof value.statusCode === 'number' ? value.statusCode : undefined
  const retryable = typeof value.isRetryable === 'boolean' ? value.isRetryable : undefined
  const name = typeof value.name === 'string' ? value.name : 'Error'
  let message = typeof value.message === 'string' ? value.message : 'An unknown stream error occurred.'

  for (const pattern of FULL_SECRET_PATTERNS) {
    message = message.replace(pattern, '[redacted]')
  }
  for (const pattern of PREFIXED_SECRET_PATTERNS) {
    message = message.replace(pattern, '$1[redacted]')
  }
  message = message.replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, 'https://[redacted]@')
  message = message.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  const details = [statusCode ? `HTTP ${statusCode}` : '', retryable === true ? 'retryable' : ''].filter(Boolean).join(', ')
  const safeMessage = message.slice(0, 500) || 'An unknown stream error occurred.'
  return `${name}${details ? ` (${details})` : ''}: ${safeMessage}`
}
