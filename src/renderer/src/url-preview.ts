export type LinkKind = 'web' | 'file' | 'other'

export interface LinkClassification {
  kind: LinkKind
  isMarkdown: boolean
}

export function classifyLink(value: string): LinkClassification {
  try {
    const url = new URL(value)
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return { kind: 'web', isMarkdown: false }
    }
    if (url.protocol === 'file:') {
      const pathname = decodeURIComponent(url.pathname).toLowerCase()
      return { kind: 'file', isMarkdown: pathname.endsWith('.md') || pathname.endsWith('.markdown') }
    }
  } catch {
    // Invalid and relative links are not actionable external links.
  }
  return { kind: 'other', isMarkdown: false }
}

export interface UrlToken {
  type: 'text' | 'url'
  value: string
}

const URL_PATTERN = /(?:https?:\/\/|file:\/\/)[^\s<>]+/gi
const TRAILING_PUNCTUATION = /[\]})>,.!?:;，。！？：；）》】》、]+$/u

export function splitUrls(text: string): UrlToken[] {
  const tokens: UrlToken[] = []
  let cursor = 0
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0
    const raw = match[0]
    if (start > cursor) tokens.push({ type: 'text', value: text.slice(cursor, start) })
    const trimmed = raw.replace(TRAILING_PUNCTUATION, '')
    if (!trimmed) {
      tokens.push({ type: 'text', value: raw })
      cursor = start + raw.length
      continue
    }
    tokens.push({ type: 'url', value: trimmed })
    const punctuation = raw.slice(trimmed.length)
    if (punctuation) tokens.push({ type: 'text', value: punctuation })
    cursor = start + raw.length
  }
  if (cursor < text.length) tokens.push({ type: 'text', value: text.slice(cursor) })
  return tokens.length > 0 ? tokens : [{ type: 'text', value: text }]
}

export function compactUrl(url: string, maxLength = 72): string {
  if (url.length <= maxLength) return url
  const parsed = new URL(url)
  const prefix = `${parsed.protocol}//${parsed.host}`
  const suffix = parsed.pathname + parsed.search + parsed.hash
  const available = Math.max(12, maxLength - prefix.length - 1)
  if (suffix.length <= available) return `${prefix}${suffix}`
  const tail = Math.max(8, Math.floor(available / 2))
  return `${prefix}/${suffix.replace(/^\//, '').slice(0, Math.max(1, available - tail - 1))}…${suffix.slice(-tail)}`
}

export function linkLabel(value: string): string {
  try {
    const parsed = new URL(value)
    if (parsed.protocol === 'file:') {
      const pathname = decodeURIComponent(parsed.pathname)
      return pathname.split('/').pop() || pathname || value
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return compactUrl(value, 64)
    }
  } catch {
    // Keep the original value as a safe fallback label.
  }
  return value
}
