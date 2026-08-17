import * as electron from 'electron'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getJokerHomeDir } from './paths'

/**
 * Causal operation journal: a per-session sidecar JSONL
 * (`<sessionId>.operations.jsonl`) that records what happened BEFORE each
 * side effect is allowed to start. Session JSON snapshots keep serving fast UI
 * reads; this journal owns causal recovery and audit.
 *
 * The write is synchronous on purpose: an operation may only begin after its
 * intent line is durable, mirroring the claim/commit protocol the Goal domain
 * already uses.
 */

export type OperationEvent =
  | { type: 'request-prepared'; at: number; runId: string; step?: number }
  | { type: 'request-dispatched'; at: number; runId: string; step?: number }
  | { type: 'tool-proposed'; at: number; runId: string; toolCallId: string; toolName: string }
  | { type: 'approval-asked'; at: number; runId: string; toolCallId: string }
  | { type: 'approval-decided'; at: number; runId: string; toolCallId: string; outcome: 'allow' | 'deny' }
  | { type: 'tool-started'; at: number; runId: string; toolCallId: string; toolName: string }
  | { type: 'tool-result'; at: number; runId: string; toolCallId: string; status: 'done' | 'denied' | 'error' | 'timed-out' | 'cancelled' }
  | { type: 'step-committed'; at: number; runId: string; step: number }
  | { type: 'run-terminal'; at: number; runId: string; status: string }

export interface OperationJournal {
  append(event: OperationEvent): void
}

let operationsDirOverride: string | null = null

/** Test-only storage override; production callers use the default app directory. */
export function setOperationsDirForTests(dir: string | null): void {
  operationsDirOverride = dir
}

function getOperationsDir(): string {
  if (operationsDirOverride) return operationsDirOverride
  const home = typeof electron.app?.getPath === 'function' ? electron.app.getPath('home') : getJokerHomeDir()
  return join(home, '.joker', 'sessions')
}

export function operationsPath(sessionId: string): string {
  return join(getOperationsDir(), `${sessionId}.operations.jsonl`)
}

export function appendOperation(sessionId: string, event: OperationEvent): void {
  const dir = getOperationsDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  appendFileSync(operationsPath(sessionId), `${JSON.stringify(event)}\n`, 'utf8')
}

export function readOperations(sessionId: string): OperationEvent[] {
  const path = operationsPath(sessionId)
  if (!existsSync(path)) return []
  const events: OperationEvent[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line) as OperationEvent)
    } catch {
      // A torn tail line from a crash mid-write carries no causal meaning.
    }
  }
  return events
}

export interface MissingToolOutcome {
  toolCallId: string
  toolName: string
  kind: 'TOOL_NOT_STARTED' | 'TOOL_OUTCOME_UNKNOWN'
}

/**
 * Classify tools without a durably recorded result:
 * - TOOL_NOT_STARTED: a durable intent exists but no `tool-started` line, so
 *   the tool body never ran and the call can be safely re-issued;
 * - TOOL_OUTCOME_UNKNOWN: `tool-started` is durable but no result is, so the
 *   side effect may have happened and the call MUST NOT be auto-retried.
 */
export function classifyInterruptedRun(events: OperationEvent[]): MissingToolOutcome[] {
  const tools = new Map<string, { toolName: string; started: boolean; result: boolean }>()
  for (const event of events) {
    if (event.type === 'tool-proposed') {
      const entry = tools.get(event.toolCallId) ?? { toolName: event.toolName, started: false, result: false }
      tools.set(event.toolCallId, entry)
    } else if (event.type === 'tool-started') {
      const entry = tools.get(event.toolCallId) ?? { toolName: event.toolName, started: false, result: false }
      entry.started = true
      entry.toolName = event.toolName
      tools.set(event.toolCallId, entry)
    } else if (event.type === 'tool-result') {
      const entry = tools.get(event.toolCallId) ?? { toolName: '', started: true, result: false }
      entry.result = true
      tools.set(event.toolCallId, entry)
    }
  }
  const missing: MissingToolOutcome[] = []
  for (const [toolCallId, entry] of tools) {
    if (entry.result) continue
    missing.push({
      toolCallId,
      toolName: entry.toolName,
      kind: entry.started ? 'TOOL_OUTCOME_UNKNOWN' : 'TOOL_NOT_STARTED'
    })
  }
  return missing
}

export interface InterruptedRunView {
  runId?: string
  missing: MissingToolOutcome[]
}

/**
 * Causal view of the latest run that never recorded `run-terminal`: its events
 * plus the missing-tool classification. An empty `missing` list means either no
 * interruption or an interrupted run with no pending tool side effects.
 */
export function readInterruptedRun(sessionId: string): InterruptedRunView {
  const events = readOperations(sessionId)
  let start = 0
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'run-terminal') {
      start = index + 1
      break
    }
  }
  const tail = events.slice(start)
  const runId = tail.length > 0 ? tail[0].runId : undefined
  return { runId, missing: classifyInterruptedRun(tail) }
}
