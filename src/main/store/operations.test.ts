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
  readToolRecoveries,
  resolveToolRecovery,
  spillToolResult,
  readSpilledToolResult,
  cleanupSpilledToolResults,
  projectToolCallsFromOperations,
  projectToolCallsIntoMessages,
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

void test('journal lifecycle projects proposed, approval, running, and terminal facts in order', () => {
  const events: OperationEvent[] = [
    { type: 'tool-proposed', at: 10, runId: 'run-projection', toolCallId: 'call-projection', toolName: 'Write' },
    { type: 'approval-asked', at: 20, runId: 'run-projection', toolCallId: 'call-projection' },
    { type: 'approval-decided', at: 30, runId: 'run-projection', toolCallId: 'call-projection', outcome: 'allow' },
    { type: 'tool-started', at: 40, runId: 'run-projection', toolCallId: 'call-projection', toolName: 'Write' },
    { type: 'tool-result', at: 55, runId: 'run-projection', toolCallId: 'call-projection', status: 'done' }
  ]
  const [projection] = projectToolCallsFromOperations(events)
  assert.equal(projection?.runId, 'run-projection')
  assert.deepEqual(projection?.toolCall, {
    toolCallId: 'call-projection',
    toolName: 'Write',
    input: {},
    status: 'done',
    proposedAt: 10,
    approvalAskedAt: 20,
    approvalDecidedAt: 30,
    approvalOutcome: 'allow',
    startedAt: 40,
    completedAt: 55,
    updatedAt: 55,
    lastProgressAt: 55,
    durationMs: 15
  })
})

void test('approval activity decides whether an asked approval is still pending', () => {
  const events: OperationEvent[] = [
    { type: 'tool-proposed', at: 1, runId: 'run-approval', toolCallId: 'call-approval', toolName: 'Bash' },
    { type: 'approval-asked', at: 2, runId: 'run-approval', toolCallId: 'call-approval' }
  ]
  assert.equal(projectToolCallsFromOperations(events, {
    assumeApprovalPending: false,
    pendingApprovalToolCallIds: new Set(['call-approval'])
  })[0]?.toolCall.status, 'awaiting-approval')
  assert.equal(projectToolCallsFromOperations(events, {
    assumeApprovalPending: false,
    pendingApprovalToolCallIds: new Set()
  })[0]?.toolCall.status, 'proposed')
})

void test('started tools without a durable result become outcome-unknown only after their run is inactive', () => {
  const events: OperationEvent[] = [
    { type: 'tool-proposed', at: 1, runId: 'run-interrupted', toolCallId: 'call-interrupted', toolName: 'Bash' },
    { type: 'approval-decided', at: 2, runId: 'run-interrupted', toolCallId: 'call-interrupted', outcome: 'allow' },
    { type: 'tool-started', at: 3, runId: 'run-interrupted', toolCallId: 'call-interrupted', toolName: 'Bash' }
  ]
  const inactive = projectToolCallsFromOperations(events)[0]?.toolCall
  assert.equal(inactive?.status, 'outcome-unknown')
  assert.equal(inactive?.errorCode, 'TOOL_OUTCOME_UNKNOWN')
  const active = projectToolCallsFromOperations(events, { activeRunIds: new Set(['run-interrupted']) })[0]?.toolCall
  assert.equal(active?.status, 'running')
  assert.equal(active?.errorCode, undefined)
})

void test('journal-only calls synthesize a ToolCard message and merge stronger recovery state into saved calls', () => {
  const projections = projectToolCallsFromOperations([
    { type: 'tool-proposed', at: 1, runId: 'run-existing', toolCallId: 'call-existing', toolName: 'Write' },
    { type: 'tool-started', at: 2, runId: 'run-existing', toolCallId: 'call-existing', toolName: 'Write' },
    { type: 'tool-proposed', at: 3, runId: 'run-journal-only', toolCallId: 'call-journal-only', toolName: 'Read' }
  ])
  const messages = projectToolCallsIntoMessages([{
    id: 'message-existing',
    role: 'assistant',
    content: '',
    toolCalls: [{ toolCallId: 'call-existing', toolName: 'Write', input: { path: 'a.txt' }, status: 'running' }],
    createdAt: 1
  }], projections)
  assert.equal(messages[0]?.toolCalls?.[0]?.status, 'outcome-unknown')
  assert.deepEqual(messages[0]?.toolCalls?.[0]?.input, { path: 'a.txt' })
  assert.equal(messages[1]?.id, 'operation-journal-run-journal-only')
  assert.equal(messages[1]?.toolCalls?.[0]?.status, 'proposed')
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

void test('unknown outcome guard blocks only the identical scoped v2 call', () => {
  const definition = { name: 'Write', source: { type: 'builtin' as const, id: 'Write' } }
  const fingerprint = toolInputFingerprint({ workspacePath: 'C:/workspace', definition }, { filePath: 'a.txt', content: 'x' })
  const guard = unknownOutcomeGuard([{ recoveryId: 'recovery-1', sourceRunId: 'run-1', sourceToolCallId: 'call-1', toolName: 'Write', ...fingerprint, fingerprintVersion: 'v2', retrySemantics: 'verify-before-retry', recommendedAction: 'retry-requires-verification', revision: 0, createdAt: 1, status: 'unresolved' }])
  const base = { definition: definition as never, context: { workspacePath: 'C:/workspace' } as never }
  assert.match((guard({ ...base, toolName: 'Write', input: { content: 'x', filePath: 'a.txt' } }) as { reason: string }).reason, /verify current state/)
  assert.equal(guard({ ...base, toolName: 'Write', input: { filePath: 'b.txt', content: 'x' } }), undefined)
  assert.equal(guard({ definition: definition as never, context: { workspacePath: 'D:/workspace' } as never, toolName: 'Write', input: { filePath: 'a.txt', content: 'x' } }), undefined)
})

void test('unknown outcome guard does not block not-started or legacy calls without fingerprints', () => {
  const guard = unknownOutcomeGuard([
    { recoveryId: 'recovery-1', sourceRunId: 'run-1', sourceToolCallId: 'call-1', toolName: 'Write', fingerprintVersion: 'legacy-v1', retrySemantics: 'never-automatic', recommendedAction: 'retry-requires-user-authorization', revision: 0, createdAt: 1, status: 'unresolved' },
    { recoveryId: 'recovery-2', sourceRunId: 'run-2', sourceToolCallId: 'call-2', toolName: 'Write', inputFingerprint: toolInputFingerprint('Write', { filePath: 'a.txt' }), fingerprintVersion: 'legacy-v1', retrySemantics: 'never-automatic', recommendedAction: 'retry-requires-user-authorization', revision: 1, createdAt: 2, status: 'resolved', resolution: 'verified-not-applied', resolvedAt: 3 }
  ])
  assert.equal(guard({ toolName: 'Write', input: { filePath: 'a.txt' }, definition: {} as never, context: {} as never }), undefined)
})

void test('verified-applied resolution permanently blocks the identical call while not-applied re-allows it', () => {
  const definition = { name: 'Write', source: { type: 'builtin' as const, id: 'Write' } }
  const applied = toolInputFingerprint({ workspacePath: 'C:/workspace', definition }, { filePath: 'applied.txt' })
  const guard = unknownOutcomeGuard([
    { recoveryId: 'recovery-applied', sourceRunId: 'run-1', sourceToolCallId: 'call-1', toolName: 'Write', ...applied, fingerprintVersion: 'v2', retrySemantics: 'verify-before-retry', recommendedAction: 'retry-requires-verification', revision: 1, createdAt: 1, status: 'resolved', resolution: 'verified-applied', resolvedAt: 2 }
  ])
  const denial = guard({ toolName: 'Write', input: { filePath: 'applied.txt' }, definition: definition as never, context: { workspacePath: 'C:/workspace' } as never }) as { code?: string; requiresUserAction?: boolean }
  assert.equal(denial?.code, 'TOOL_ALREADY_APPLIED')
  assert.equal(denial?.requiresUserAction, undefined)
})


void test('retry semantics decision table only blocks verification and never-automatic calls', () => {
  const definition = { name: 'Fixture', source: { type: 'builtin' as const, id: 'Fixture' } }
  const input = { idempotencyKey: 'k1' }
  const fingerprint = toolInputFingerprint({ workspacePath: 'C:/workspace', definition }, input)
  const base = { sourceRunId: 'run', sourceToolCallId: 'call', toolName: 'Fixture', ...fingerprint, fingerprintVersion: 'v2' as const, revision: 0, createdAt: 1, status: 'unresolved' as const }
  for (const retrySemantics of ['read-only', 'idempotent', 'idempotent-with-key'] as const) {
    const guard = unknownOutcomeGuard([{ ...base, recoveryId: retrySemantics, retrySemantics, recommendedAction: 'automatic-retry-allowed' }])
    assert.equal(guard({ toolName: 'Fixture', input, definition: definition as never, context: { workspacePath: 'C:/workspace' } as never }), undefined)
  }
  for (const [retrySemantics, recommendedAction] of [['verify-before-retry', 'retry-requires-verification'], ['never-automatic', 'retry-requires-user-authorization']] as const) {
    const guard = unknownOutcomeGuard([{ ...base, recoveryId: retrySemantics, retrySemantics, recommendedAction }])
    const denial = guard({ toolName: 'Fixture', input, definition: definition as never, context: { workspacePath: 'C:/workspace' } as never }) as { code?: string; requiresUserAction?: boolean }
    assert.equal(denial.code, 'TOOL_OUTCOME_UNKNOWN')
    assert.equal(denial.requiresUserAction, true)
  }
})

void test('large tool results spill to session-owned storage and support bounded reads', () => {
  withDir(() => {
    const output = `head-${'x'.repeat(140_000)}-tail`
    const spill = spillToolResult('session-spill', 'call-spill', output)
    assert.ok(spill)
    assert.equal(spill.truncated, true)
    assert.match(spill.preview, /Full tool result stored as spill/)
    const secondSpill = spillToolResult('session-spill', 'call-spill', output)
    assert.ok(secondSpill)
    assert.notEqual(secondSpill.id, spill.id)
    const first = readSpilledToolResult('session-spill', spill.id, 0, 100)
    assert.equal(first?.content, output.slice(0, 100))
    assert.equal(first?.offsetBytes, 0)
    assert.equal(first?.contentBytes, 100)
    assert.equal(first?.nextOffsetBytes, 100)
    assert.equal(readSpilledToolResult('other-session', spill.id), null)
    assert.equal(readSpilledToolResult('session-spill', '../escape'), null)
    cleanupSpilledToolResults('session-spill')
    assert.equal(readSpilledToolResult('session-spill', spill.id), null)
  })
})

void test('active runs do not expose premature recovery actions', () => {
  withDir(() => {
    appendOperation('session-active', { type: 'tool-proposed', at: 1, runId: 'run-active', toolCallId: 'call-active', toolName: 'Write' })
    appendOperation('session-active', { type: 'tool-started', at: 2, runId: 'run-active', toolCallId: 'call-active', toolName: 'Write' })
    assert.deepEqual(readToolRecoveries('session-active'), [])
    appendOperation('session-active', { type: 'run-terminal', at: 3, runId: 'run-active', status: 'failed' })
    assert.equal(readToolRecoveries('session-active').length, 1)
  })
})

void test('persistent recovery survives later run terminals until explicitly resolved', () => {
  withDir(() => {
    const fingerprint = toolInputFingerprint('Write', { filePath: 'a.txt' })
    appendOperation('session-recovery', { type: 'tool-proposed', at: 1, runId: 'run-crashed', toolCallId: 'call-1', toolName: 'Write', inputFingerprint: fingerprint })
    appendOperation('session-recovery', { type: 'tool-started', at: 2, runId: 'run-crashed', toolCallId: 'call-1', toolName: 'Write' })
    appendOperation('session-recovery', { type: 'run-terminal', at: 3, runId: 'run-crashed', status: 'failed' })
    const unresolved = readToolRecoveries('session-recovery')
    assert.equal(unresolved.length, 1)
    assert.equal(unresolved[0]?.status, 'unresolved')
    const resolved = resolveToolRecovery('session-recovery', { recoveryId: unresolved[0]!.recoveryId, expectedRevision: 0, resolution: 'verified-not-applied', note: 'checked file' })
    assert.equal(resolved.success, true)
    assert.equal(readToolRecoveries('session-recovery')[0]?.resolution, 'verified-not-applied')
    assert.equal(resolveToolRecovery('session-recovery', { recoveryId: unresolved[0]!.recoveryId, expectedRevision: 0, resolution: 'verified-applied' }).error, 'conflict')
  })
})

void test('recovery resolution CAS accepts only one current revision', () => {
  withDir(() => {
    appendOperation('session-cas', { type: 'tool-proposed', at: 1, runId: 'run-cas', toolCallId: 'call-cas', toolName: 'Bash', retrySemantics: 'never-automatic' })
    appendOperation('session-cas', { type: 'tool-started', at: 2, runId: 'run-cas', toolCallId: 'call-cas', toolName: 'Bash' })
    appendOperation('session-cas', { type: 'run-terminal', at: 3, runId: 'run-cas', status: 'failed' })
    const recovery = readToolRecoveries('session-cas')[0]!
    const first = resolveToolRecovery('session-cas', { recoveryId: recovery.recoveryId, expectedRevision: 0, resolution: 'user-authorized-retry' })
    const stale = resolveToolRecovery('session-cas', { recoveryId: recovery.recoveryId, expectedRevision: 0, resolution: 'verified-applied' })
    assert.equal(first.success, true)
    assert.equal(stale.error, 'conflict')
    assert.equal(readToolRecoveries('session-cas')[0]?.resolution, 'user-authorized-retry')
  })
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
