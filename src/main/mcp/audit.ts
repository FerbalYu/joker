import { appendFileSync, existsSync, mkdirSync, statSync, truncateSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getJokerHomeDir } from '../store/paths'
import { formatSafeError } from '../agent/diagnostics'
import type { McpAuditEvent } from '../../shared/types'

let auditPathOverride: string | null = null
const MAX_AUDIT_BYTES = 512 * 1024

export function setMcpAuditPathForTests(path: string | null): void {
  auditPathOverride = path
}

export function getMcpAuditPath(): string {
  return auditPathOverride ?? join(getJokerHomeDir(), '.joker', 'mcp-audit.jsonl')
}

export function writeMcpAudit(event: Omit<McpAuditEvent, 'timestamp'> & { error?: string }): void {
  try {
    const path = getMcpAuditPath()
    mkdirSync(dirname(path), { recursive: true })
    if (existsSync(path) && statSync(path).size > MAX_AUDIT_BYTES) truncateSync(path, 0)
    const safe: McpAuditEvent = {
      ...event,
      timestamp: new Date().toISOString(),
      ...(event.error ? { error: formatSafeError(new Error(event.error)) } : {})
    }
    appendFileSync(path, `${JSON.stringify(safe)}\n`, 'utf8')
  } catch {
    // Audit failure must never prevent cleanup or recovery.
  }
}
