import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  appendOperation,
  classifyInterruptedRun,
  operationsPath,
  readInterruptedRun,
  readOperations,
  toolInputFingerprint,
  unknownOutcomeGuard,
  setOperationsDirForTests,
  type OperationEvent
} from './operations'

function withDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'joker-operations-'))
  setOperationsDirForTests(dir)
  try {
    run(dir)
  } finally {
    setOperationsDirForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
}

void test('append and read round-trip preserves event order', () => {
  withDir(() => {
    const events: OperationEvent[] = [
      { type: 'request-prepared', at: 1, runId: 'run-1' },
      { type: 'tool-proposed', at: 2, runId: 'run-1', toolCallId: 'call-1', toolName: 'Write' },
      { type: 'tool-started', at: 3, runId: 'run-1', toolCallId: 'call-1', toolName: 'Write' },
      { type: 'tool-result', at: 4, runId: 'run-1', toolCallId: 'call-1', status: 'done' },
      { type: 'run-terminal', at: 5, runId: 'run-1', status: 'completed' }
    ]
    for (const event of events) appendOperation('session-a', event)

    assert.deepEqual(readOperations('session-a'), events)
    assert.ok(existsSync(operationsPath('session-a')))
    const raw = readFileSync(operationsPath('session-a'), 'utf8')
    assert.equal(raw.trim().split('\n').length, 5)
  })
})

void test('classify: proposed without started is TOOL_NOT_STARTED', () => {
  const missing = classifyInterruptedRun([
    { type: 'tool-proposed', at: 1, runId: 'run-1', toolCallId: 'call-1', toolName: 'Write' }
  ])
  assert.deepEqual(missing, [
    { toolCallId: 'call-1', toolName: 'Write', kind: 'TOOL_NOT_STARTED' }
  ])
})

void test('classify: started without result is TOOL_OUTCOME_UNKNOWN', () => {
  const missing = classifyInterruptedRun([
    { type: 'tool-proposed', at: 1, runId: 'run-1', toolCallId: 'call-1', toolName: 'Bash' },
    { type: 'tool-started', at: 2, runId: 'run-1', toolCallId: 'call-1', toolName: 'Bash' }
  ])
  assert.deepEqual(missing, [
    { toolCallId: 'call-1', toolName: 'Bash', kind: 'TOOL_OUTCOME_UNKNOWN' }
  ])
})

void test('classify: a recorded result closes the tool even on error or timeout', () => {
  for (const status of ['done', 'denied', 'error', 'timed-out', 'cancelled'] as const) {
    const missing = classifyInterruptedRun([
      { type: 'tool-proposed', at: 1, runId: 'run-1', toolCallId: 'call-1', toolName: 'Bash' },
      { type: 'tool-started', at: 2, runId: 'run-1', toolCallId: 'call-1', toolName: 'Bash' },
      { type: 'tool-result', at: 3, runId: 'run-1', toolCallId: 'call-1', status }
    ])
    assert.deepEqual(missing, [])
  }
})

void test('classify: denied tools without a result line are still unknown-safe', () => {
  const missing = classifyInterruptedRun([
    { type: 'tool-proposed', at: 1, runId: 'run-1', toolCallId: 'call-1', toolName: 'Write' },
    { type: 'approval-asked', at: 2, runId: 'run-1', toolCallId: 'call-1' },
    { type: 'approval-decided', at: 3, runId: 'run-1', toolCallId: 'call-1', outcome: 'deny' }
  ])
  assert.deepEqual(missing, [
    { toolCallId: 'call-1', toolName: 'Write', kind: 'TOOL_NOT_STARTED' }
  ])
})

void test('readInterruptedRun only considers events after the last run-terminal', () => {
  withDir(() => {
    appendOperation('session-b', { type: 'tool-proposed', at: 1, runId: 'run-old', toolCallId: 'call-old', toolName: 'Write' })
    appendOperation('session-b', { type: 'tool-started', at: 2, runId: 'run-old', toolCallId: 'call-old', toolName: 'Write' })
    appendOperation('session-b', { type: 'run-terminal', at: 3, runId: 'run-old', status: 'completed' })
    appendOperation('session-b', { type: 'request-prepared', at: 4, runId: 'run-new' })
    appendOperation('session-b', { type: 'tool-proposed', at: 5, runId: 'run-new', toolCallId: 'call-new', toolName: 'Bash' })
    appendOperation('session-b', { type: 'tool-started', at: 6, runId: 'run-new', toolCallId: 'call-new', toolName: 'Bash' })

    const view = readInterruptedRun('session-b')
    assert.equal(view.runId, 'run-new')
    assert.deepEqual(view.missing, [
      { toolCallId: 'call-new', toolName: 'Bash', kind: 'TOOL_OUTCOME_UNKNOWN' }
    ])
  })
})

void test('readInterruptedRun returns no missing tools for a cleanly terminated journal', () => {
  withDir(() => {
    appendOperation('session-c', { type: 'tool-proposed', at: 1, runId: 'run-1', toolCallId: 'call-1', toolName: 'Write' })
    appendOperation('session-c', { type: 'tool-started', at: 2, runId: 'run-1', toolCallId: 'call-1', toolName: 'Write' })
    appendOperation('session-c', { type: 'tool-result', at: 3, runId: 'run-1', toolCallId: 'call-1', status: 'done' })
    appendOperation('session-c', { type: 'run-terminal', at: 4, runId: 'run-1', status: 'completed' })

    assert.deepEqual(readInterruptedRun('session-c'), { runId: undefined, missing: [] })
  })
})

void test('unknown outcome guard blocks only the identical canonical tool call', () => {
  const fingerprint = toolInputFingerprint('Write', { filePath: 'a.txt', content: 'x' })
  const guard = unknownOutcomeGuard([{ toolCallId: 'call-1', toolName: 'Write', inputFingerprint: fingerprint, kind: 'TOOL_OUTCOME_UNKNOWN' }])
  const base = { definition: {} as never, context: {} as never }
  assert.match(guard({ ...base, toolName: 'Write', input: { content: 'x', filePath: 'a.txt' } }) ?? '', /interrupted previous run/)
  assert.equal(guard({ ...base, toolName: 'Write', input: { filePath: 'b.txt', content: 'x' } }), undefined)
  assert.equal(guard({ ...base, toolName: 'Read', input: { filePath: 'a.txt', content: 'x' } }), undefined)
})

void test('unknown outcome guard does not block not-started or legacy calls without fingerprints', () => {
  const guard = unknownOutcomeGuard([
    { toolCallId: 'call-1', toolName: 'Write', inputFingerprint: toolInputFingerprint('Write', { filePath: 'a.txt' }), kind: 'TOOL_NOT_STARTED' },
    { toolCallId: 'call-2', toolName: 'Write', kind: 'TOOL_OUTCOME_UNKNOWN' }
  ])
  assert.equal(guard({ toolName: 'Write', input: { filePath: 'a.txt' }, definition: {} as never, context: {} as never }), undefined)
})

void test('readOperations tolerates a torn tail line from a crash mid-write', () => {
  withDir((dir) => {
    const path = join(dir, 'session-d.operations.jsonl')
    writeFileSync(path, '{"type":"tool-proposed","at":1,"runId":"run-1","toolCallId":"call-1","toolName":"Write"}\n{"type":"tool-start', 'utf8')

    const events = readOperations('session-d')
    assert.equal(events.length, 1)
    assert.equal(events[0]?.type, 'tool-proposed')
  })
})
