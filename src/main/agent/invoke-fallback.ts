export interface InvokeToolCall {
  toolName: string
  input: Record<string, unknown>
}

const INVOKE_HEADER = /invoke\s+(?:tool\s+)?([A-Za-z][A-Za-z0-9_-]*)\s+with\s+/i

/**
 * Best-effort parser for models that describe a tool call in prose instead of
 * emitting a real `tool_calls` block, e.g. `invoke ToolSearch with query is x`.
 *
 * Handles JSON values (objects/arrays/strings/numbers/booleans/null) and bare
 * single-token values. Multi-word bare values are ambiguous and intentionally
 * unsupported.
 */
export function parseInvokeToolCall(text: string): InvokeToolCall | null {
  const header = text.match(INVOKE_HEADER)
  if (!header) return null
  const input = parseInvokeArgs(text.slice((header.index ?? 0) + header[0].length))
  if (Object.keys(input).length === 0) return null
  return { toolName: header[1], input }
}

function parseInvokeArgs(body: string): Record<string, unknown> {
  const input: Record<string, unknown> = {}
  let rest = body
  while (true) {
    const name = rest.match(/^\s*(\S+)\s+is\s+/)
    if (!name) break
    rest = rest.slice(name[0].length)
    const trimmed = rest.replace(/^\s+/, '')
    if (!trimmed) break
    const parsed = readInvokeValue(trimmed)
    if (parsed === undefined) break
    input[name[1]] = parsed.value
    rest = trimmed.slice(parsed.consumed)
    // Tolerate an " is " separator between a bare value and the next name.
    rest = rest.replace(/^\s+is\s+/, '')
  }
  return input
}

function readInvokeValue(text: string): { value: unknown; consumed: number } | undefined {
  const lead = text[0]
  if (lead === '{' || lead === '[') {
    const end = balancedEnd(text)
    if (end < 0) return undefined
    try {
      return { value: JSON.parse(text.slice(0, end)), consumed: end }
    } catch {
      return undefined
    }
  }
  if (lead === '"') {
    const end = quotedEnd(text)
    if (end < 0) return undefined
    try {
      return { value: JSON.parse(text.slice(0, end)), consumed: end }
    } catch {
      return undefined
    }
  }
  const space = text.search(/\s/)
  const token = space >= 0 ? text.slice(0, space) : text
  if (!token) return undefined
  return { value: coerceBare(token), consumed: token.length }
}

function coerceBare(token: string): unknown {
  if (/^(true|false)$/i.test(token)) return token.toLowerCase() === 'true'
  if (/^null$/i.test(token)) return null
  if (/^-?\d+(\.\d+)?$/.test(token)) return Number(token)
  return token
}

function balancedEnd(text: string): number {
  const open = text[0]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === open) depth += 1
    else if (char === close) {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return -1
}

function quotedEnd(text: string): number {
  let escaped = false
  for (let i = 1; i < text.length; i += 1) {
    const char = text[i]
    if (escaped) escaped = false
    else if (char === '\\') escaped = true
    else if (char === '"') return i + 1
  }
  return -1
}
