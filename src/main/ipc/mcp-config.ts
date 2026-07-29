import { validatePublicUrl } from '../tools/url-policy'
import type { McpServerConfig } from '../../shared/types'

const SENSITIVE_HEADER_PATTERN = /authorization|cookie|token|secret|api[-_]?key|password/i
const MAX_HEADER_COUNT = 30
const MAX_HEADER_NAME_LENGTH = 80
const MAX_HEADER_VALUE_LENGTH = 4096
const MAX_HEADER_TOTAL_LENGTH = 32 * 1024
const MAX_TIMEOUT_MS = 120_000
const MAX_RETRIES = 5

function boundedTimeout(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(MAX_TIMEOUT_MS, Math.max(100, Math.floor(value))) : fallback
}

function normalizeRecovery(value: unknown): McpServerConfig['recovery'] | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as { maxRetries?: unknown; baseDelayMs?: unknown; maxDelayMs?: unknown }
  return {
    maxRetries: typeof candidate.maxRetries === 'number' ? Math.min(MAX_RETRIES, Math.max(0, Math.floor(candidate.maxRetries))) : 3,
    baseDelayMs: boundedTimeout(candidate.baseDelayMs, 250),
    maxDelayMs: boundedTimeout(candidate.maxDelayMs, 10_000)
  }
}

export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADER_PATTERN.test(name)
}

export function maskHeaderValue(name: string, value: string): string {
  if (!isSensitiveHeader(name) || !value) return value
  if (value.length <= 8) return '••••'
  return `${value.slice(0, 4)}••••${value.slice(-4)}`
}

export function maskHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return headers
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, maskHeaderValue(name, value)]))
}

export function restoreHeaders(incoming: Record<string, string> | undefined, previous: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!incoming) return incoming
  return Object.fromEntries(Object.entries(incoming).map(([name, value]) => [name, isSensitiveHeader(name) && value.includes('••') ? previous?.[name] ?? '' : value]))
}

export function normalizeHeaders(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid MCP headers')
  const entries = Object.entries(value)
  if (entries.length > MAX_HEADER_COUNT) throw new Error('Too many MCP headers')
  const headers: Record<string, string> = {}
  let totalLength = 0
  for (const [name, rawValue] of entries) {
    if (!/^[A-Za-z0-9-]{1,80}$/.test(name) || name.length > MAX_HEADER_NAME_LENGTH) throw new Error('Invalid MCP header name')
    if (typeof rawValue !== 'string' || rawValue.length > MAX_HEADER_VALUE_LENGTH || /[\r\n]/.test(rawValue)) throw new Error('Invalid MCP header value')
    totalLength += name.length + rawValue.length
    if (totalLength > MAX_HEADER_TOTAL_LENGTH) throw new Error('MCP headers are too large')
    headers[name] = rawValue
  }
  return headers
}

export function validateServerConfig(value: unknown): McpServerConfig {
  if (!value || typeof value !== 'object') throw new Error('Invalid MCP server configuration')
  const candidate = value as Partial<McpServerConfig>
  if (typeof candidate.id !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(candidate.id)) throw new Error('Invalid MCP server id')
  if (typeof candidate.name !== 'string' || !candidate.name.trim()) throw new Error('MCP server name is required')
  if (candidate.transport !== 'stdio' && candidate.transport !== 'http') throw new Error('Invalid MCP transport')
  if (candidate.transport === 'stdio' && (!candidate.command || typeof candidate.command !== 'string')) throw new Error('stdio transport requires a command')
  if (candidate.transport === 'http') {
    if (!candidate.url || typeof candidate.url !== 'string') throw new Error('http transport requires a url')
    const normalizedUrl = validatePublicUrl(candidate.url.trim())
    if (normalizedUrl.toString().length > 2048) throw new Error('MCP URL is too long')
    candidate.url = normalizedUrl.toString()
  }
  return {
    id: candidate.id,
    name: candidate.name.trim().slice(0, 120),
    enabled: candidate.enabled !== false,
    transport: candidate.transport,
    command: typeof candidate.command === 'string' ? candidate.command.trim().slice(0, 240) : undefined,
    args: Array.isArray(candidate.args) ? candidate.args.filter((arg): arg is string => typeof arg === 'string').slice(0, 50) : undefined,
    url: typeof candidate.url === 'string' ? candidate.url.trim().slice(0, 2048) : undefined,
    headers: normalizeHeaders(candidate.headers),
    autoConnect: candidate.autoConnect !== false,
    trustState: candidate.trustState === 'trusted' ? 'trusted' : candidate.trustState === 'changed' ? 'changed' : 'untrusted',
    trustedFingerprint: typeof candidate.trustedFingerprint === 'string' && /^[a-f0-9]{32}$/.test(candidate.trustedFingerprint) ? candidate.trustedFingerprint : undefined,
    permission: candidate.permission === 'allow' ? 'allow' : 'deny',
    initializeTimeoutMs: boundedTimeout(candidate.initializeTimeoutMs, 30_000),
    callTimeoutMs: boundedTimeout(candidate.callTimeoutMs, 30_000),
    recovery: normalizeRecovery(candidate.recovery)
  }
}
