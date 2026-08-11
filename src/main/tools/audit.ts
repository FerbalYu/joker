import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getJokerHomeDir } from '../store/paths'
import { formatSafeError } from '../agent/diagnostics'
import type { ToolRisk } from './risk'

export type ToolAuditStage = 'proposed' | 'approval_resolved' | 'started' | 'finished'
export type ToolAuditStatus = 'pending' | 'allowed' | 'denied' | 'success' | 'error' | 'cancelled' | 'timed-out'

export interface ToolAuditEvent {
  timestamp: string
  sessionId: string
  runId?: string
  tool: string
  source: 'builtin' | 'mcp' | 'generated'
  sourceId?: string
  toolId?: string
  versionId?: string
  fingerprint?: string
  validationReportId?: string
  pointerRevision?: number
  capabilityRevision?: number
  risk: ToolRisk
  stage: ToolAuditStage
  status: ToolAuditStatus
  reason?: string
  durationMs?: number
  arguments?: unknown
  resultPreview?: string
  error?: string
}

export type ToolAuditWriter = (event: Omit<ToolAuditEvent, 'timestamp'>) => void

let auditPathOverride: string | null = null
const MAX_AUDIT_BYTES = 512 * 1024
const PREVIEW_LIMIT = 500
const SECRET_KEYS = ['token', 'secret', 'password', 'apikey', 'api_key', 'authorization', 'cookie']
const BODY_KEYS = new Set(['body', 'content', 'html'])
const SENSITIVE_ARG_KEYS = new Set(['command', 'prompt', 'oldstring', 'newstring', 'query'])
const SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /sk-[A-Za-z0-9]{20,}/gi,
  /AKIA[0-9A-Z]{16}/g
]
const QUERY_SECRET_PATTERN = /([?&](?:api_key|apikey|token|access_token|password|secret)=)[^&\s]+/gi

export function setToolAuditPathForTests(path: string | null): void {
  auditPathOverride = path
}

export function getToolAuditPath(): string {
  return auditPathOverride ?? join(getJokerHomeDir(), '.joker', 'tool-audit.jsonl')
}

export const writeToolAudit: ToolAuditWriter = (event) => {
  try {
    const path = getToolAuditPath()
    mkdirSync(dirname(path), { recursive: true })
    if (existsSync(path) && statSync(path).size > MAX_AUDIT_BYTES) {
      const backup = `${path}.1`
      try { renameSync(path, backup) } catch { /* best effort rotation */ }
    }
    const safe: ToolAuditEvent = {
      ...event,
      timestamp: new Date().toISOString(),
      arguments: sanitizeAuditValue(event.arguments),
      ...(event.resultPreview ? { resultPreview: redactSecrets(truncatePreview(event.resultPreview)) } : {}),
      ...(event.error ? { error: formatSafeError(new Error(event.error)) } : {})
    }
    appendFileSync(path, `${JSON.stringify(safe)}\n`, 'utf8')
  } catch {
    // Audit failure must never change tool execution.
  }
}

export function sanitizeAuditValue(value: unknown, key = '', depth = 0): unknown {
  const normalizedKey = key.toLowerCase().replace(/[^a-z0-9_]/g, '')
  if (SECRET_KEYS.some((secret) => normalizedKey.includes(secret))) return '[redacted]'
  if (BODY_KEYS.has(normalizedKey) || [...BODY_KEYS].some((bodyKey) => normalizedKey.endsWith(`_${bodyKey}`))) return '[redacted body]'
  if (SENSITIVE_ARG_KEYS.has(normalizedKey)) return '[redacted]'
  if (normalizedKey === 'text' && depth === 1) return '[redacted input]'
  if (typeof value === 'string') return redactSecrets(truncatePreview(value))
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return value
  if (depth >= 4) return '[truncated depth]'
  if (Array.isArray(value)) return value.slice(0, 10).map((item) => sanitizeAuditValue(item, '', depth + 1))
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 20).map(([childKey, childValue]) => [
      childKey,
      sanitizeAuditValue(childValue, childKey, depth + 1)
    ]))
  }
  return redactSecrets(truncatePreview(String(value)))
}

export function truncatePreview(value: string): string {
  const normalized = value.replace(/\r?\n/g, '\\n')
  return normalized.length <= PREVIEW_LIMIT ? normalized : `${normalized.slice(0, PREVIEW_LIMIT - 3)}...`
}

export function redactSecrets(value: string): string {
  let result = value
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, '[redacted]')
  }
  result = result.replace(QUERY_SECRET_PATTERN, '$1[redacted]')
  return result
}
