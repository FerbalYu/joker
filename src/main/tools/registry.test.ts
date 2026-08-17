import test from 'node:test'
import assert from 'node:assert/strict'
import { buildToolSet, executeToolDefinition, type ToolContext } from './registry'
import { z } from 'zod'
import type { OperationEvent } from '../store/operations'

void test('buildToolSet passes sessionId through to tool execution', async () => {
  let received: string | undefined
  let receivedWorkspace: string | null | undefined
  const toolSet = buildToolSet([
    {
      name: 'Capture',
      description: 'capture context',
      inputSchema: z.object({ value: z.string() }),
      execute: async (_input, context) => {
        received = context.sessionId
        receivedWorkspace = context.workspacePath
        return { output: 'ok' }
      }
    }
  ], {
    workspacePath: process.cwd(),
    sessionId: 'session-a',
    runId: 'run-a',
    approvalGate: async () => ({ outcome: 'allow', risk: 'read', reason: 'test approval' })
  } satisfies ToolContext)

  const result = await (toolSet.Capture as unknown as { execute: (input: Record<string, unknown>) => Promise<{ output: string }> }).execute({ value: 'x' })
  assert.equal(result.output, 'ok')
  assert.equal(received, 'session-a')
  assert.equal(receivedWorkspace, process.cwd())
})

void test('buildToolSet preserves a missing workspace without falling back', async () => {
  let receivedWorkspace: string | null | undefined
  const toolSet = buildToolSet([
    {
      name: 'CaptureWorkspace',
      description: 'capture missing workspace',
      inputSchema: z.object({}),
      execute: async (_input, context) => {
        receivedWorkspace = context.workspacePath
        return { output: 'ok' }
      }
    }
  ], {
    workspacePath: null,
    sessionId: 'session-no-workspace',
    approvalGate: async () => ({ outcome: 'allow', risk: 'read', reason: 'test approval' })
  })

  const result = await (toolSet.CaptureWorkspace as unknown as { execute: (input: Record<string, unknown>) => Promise<{ output: string }> }).execute({})
  assert.equal(result.output, 'ok')
  assert.equal(receivedWorkspace, null)
})

void test('buildToolSet does not execute a denied tool', async () => {
  let executed = false
  const toolSet = buildToolSet([
    {
      name: 'Denied',
      description: 'denied tool',
      inputSchema: z.object({}),
      execute: async () => {
        executed = true
        return { output: 'unexpected' }
      }
    }
  ], {
    workspacePath: process.cwd(),
    sessionId: 'session-a',
    runId: 'run-a',
    approvalGate: async () => ({ outcome: 'deny', risk: 'external', reason: 'test denial' })
  })

  const result = await (toolSet.Denied as unknown as { execute: (input: Record<string, unknown>) => Promise<{ output: string }> }).execute({})
  assert.equal(executed, false)
  assert.equal(result.output, 'Tool call was denied.')
})

void test('buildToolSet audits the complete successful lifecycle', async () => {
  const events: Array<Record<string, unknown>> = []
  const toolSet = buildToolSet([{
    name: 'CaptureAudit',
    description: 'capture audit events',
    inputSchema: z.object({ token: z.string() }),
    risk: 'external',
    execute: async () => ({ output: 'completed output' })
  }], {
    workspacePath: process.cwd(),
    sessionId: 'session-audit',
    runId: 'run-audit',
    approvalGate: async () => ({ outcome: 'allow', risk: 'external', reason: 'approved by test' }),
    auditWriter: (event) => events.push(event)
  })

  await (toolSet.CaptureAudit as unknown as { execute: (input: Record<string, unknown>) => Promise<{ output: string }> }).execute({ token: 'secret' })
  assert.deepEqual(events.map((event) => [event.stage, event.status]), [
    ['proposed', 'pending'],
    ['approval_resolved', 'allowed'],
    ['started', 'allowed'],
    ['finished', 'success']
  ])
  assert.equal(events[3]?.resultPreview, 'completed output')
})

void test('generated tools reuse approval, audit, and observability lifecycle', async () => {
  const audit: Array<Record<string, unknown>> = []
  const observed: Array<{ status: string; toolCallId?: string }> = []
  const toolSet = buildToolSet([{
    name: 'GeneratedFixture',
    description: 'generated fixture',
    source: {
      type: 'generated',
      toolId: 'tool-1',
      name: 'Tool 1',
      versionId: 'v1',
      fingerprint: 'a'.repeat(64),
      validationReportId: 'report-1',
      pointerRevision: 1,
      capabilityRevision: 1,
      runtimeQualificationLevel: 'L2', validationProfile: 'gate2-project-read-v1'
    },
    risk: 'read',
    inputSchema: z.object({}),
    execute: async () => ({ output: 'generated output' })
  }], {
    workspacePath: process.cwd(),
    sessionId: 'session-generated',
    runId: 'run-generated',
    approvalGate: async () => ({ outcome: 'allow', risk: 'read', reason: 'generated project-read' }),
    auditWriter: (event) => audit.push(event),
    onToolCall: (event) => { observed.push(event) }
  })
  const result = await (toolSet.GeneratedFixture as unknown as { execute: (input: Record<string, unknown>, options: { toolCallId: string }) => Promise<{ output: string }> }).execute({}, { toolCallId: 'call-generated' })
  assert.equal(result.output, 'generated output')
  assert.deepEqual(audit.map((event) => [event.source, event.sourceId, event.versionId, event.validationReportId, event.stage]), [
    ['generated', 'tool-1', 'v1', 'report-1', 'proposed'],
    ['generated', 'tool-1', 'v1', 'report-1', 'approval_resolved'],
    ['generated', 'tool-1', 'v1', 'report-1', 'started'],
    ['generated', 'tool-1', 'v1', 'report-1', 'finished']
  ])
  assert.deepEqual(observed.map((event) => [event.toolCallId, event.status]), [
    ['call-generated', 'running'],
    ['call-generated', 'done']
  ])
})

void test('full-trust generated tools bypass the host approval callback', async () => {
  let executed = false
  const toolSet = buildToolSet([{
    name: 'FullTrustGeneratedFixture',
    description: 'full-trust generated fixture',
    source: {
      type: 'generated',
      toolId: 'full-trust-tool',
      name: 'Full Trust Tool',
      versionId: 'v1',
      fingerprint: 'b'.repeat(64),
      validationReportId: 'report-1',
      pointerRevision: 1,
      capabilityRevision: 1,
      runtimeQualificationLevel: 'L2',
      validationProfile: 'user-owned-full-trust-v1'
    },
    risk: 'read',
    inputSchema: z.object({}),
    execute: async () => {
      executed = true
      return { output: 'full-trust output' }
    }
  }], {
    workspacePath: process.cwd(),
    sessionId: 'session-full-trust',
    approvalGate: async () => { throw new Error('Generated Tool must not request approval') }
  })
  const result = await (toolSet.FullTrustGeneratedFixture as unknown as {
    execute: (input: Record<string, unknown>) => Promise<{ output: string }>
  }).execute({})
  assert.equal(executed, true)
  assert.equal(result.output, 'full-trust output')
})

void test('host approval grant propagates only after the approval gate resolves', async () => {
  let observedGrant: ToolContext['hostApprovalGrant']
  const grant = {
    requestId: 'request-1',
    webContentsId: 17,
    sessionId: 'session-grant',
    runId: 'run-grant',
    toolName: 'ToolPromote',
    requestHash: 'a'.repeat(64),
    approvedAt: 10
  }
  const toolSet = buildToolSet([{
    name: 'ToolPromote',
    description: 'promotion grant propagation',
    inputSchema: z.object({}),
    risk: 'write_local',
    execute: async (_input, context) => {
      observedGrant = context.hostApprovalGrant
      return { output: 'ok' }
    }
  }], {
    workspacePath: null,
    sessionId: 'session-grant',
    runId: 'run-grant',
    approvalGate: async () => ({ outcome: 'allow', risk: 'write_local', reason: 'host approved', hostGrant: grant })
  })

  await (toolSet.ToolPromote as unknown as { execute: (input: Record<string, unknown>) => Promise<{ output: string }> }).execute({})
  assert.deepEqual(observedGrant, grant)
})

void test('buildToolSet rejects duplicate tool names instead of overwriting a capability', () => {
  assert.throws(() => buildToolSet([{
    name: 'Duplicate',
    description: 'first',
    inputSchema: z.object({}),
    execute: async () => ({ output: 'first' })
  }, {
    name: 'Duplicate',
    description: 'second',
    inputSchema: z.object({}),
    execute: async () => ({ output: 'second' })
  }], {
    workspacePath: process.cwd(),
    sessionId: 'session-duplicate',
    approvalGate: async () => ({ outcome: 'allow', risk: 'read', reason: 'test' })
  }), /Duplicate ToolDefinition name/)
})

void test('buildToolSet records denial without executing or starting the tool', async () => {
  const events: Array<Record<string, unknown>> = []
  let executed = false
  const toolSet = buildToolSet([{
    name: 'DeniedAudit',
    description: 'deny with audit',
    inputSchema: z.object({}),
    execute: async () => {
      executed = true
      return { output: 'unexpected' }
    }
  }], {
    workspacePath: process.cwd(),
    sessionId: 'session-denied',
    approvalGate: async () => ({ outcome: 'deny', risk: 'external', reason: 'denied by policy' }),
    auditWriter: (event) => events.push(event)
  })

  const result = await (toolSet.DeniedAudit as unknown as { execute: (input: Record<string, unknown>) => Promise<{ output: string }> }).execute({})
  assert.equal(executed, false)
  assert.equal(result.output, 'Tool call was denied.')
  assert.deepEqual(events.map((event) => event.stage), ['proposed', 'approval_resolved', 'finished'])
})

void test('audit writer failures never change tool execution', async () => {
  const toolSet = buildToolSet([{
    name: 'AuditFailure',
    description: 'ignore audit failures',
    inputSchema: z.object({}),
    execute: async () => ({ output: 'ok' })
  }], {
    workspacePath: process.cwd(),
    sessionId: 'session-audit-failure',
    approvalGate: async () => ({ outcome: 'allow', risk: 'read', reason: 'test approval' }),
    auditWriter: () => { throw new Error('audit unavailable') }
  })

  const result = await (toolSet.AuditFailure as unknown as { execute: (input: Record<string, unknown>) => Promise<{ output: string }> }).execute({})
  assert.equal(result.output, 'ok')
})

void test('host deadline settles a tool that never returns and records timed-out status', async () => {
  const observed: Array<{ status: string; deadlineAt?: number; durationMs?: number }> = []
  await assert.rejects(executeToolDefinition({
    name: 'NeverReturns',
    description: 'deadline fixture',
    inputSchema: z.object({}),
    timeoutMs: 25,
    quiescenceGraceMs: 50,
    heartbeatMs: 5,
    execute: async () => await new Promise<never>(() => undefined)
  }, {}, {
    workspacePath: process.cwd(),
    sessionId: 'session-timeout',
    runId: 'run-timeout',
    approvalGate: async () => ({ outcome: 'allow', risk: 'read', reason: 'test' }),
    onToolCall: (event) => { observed.push(event) }
  }), /timed out/i)

  assert.equal(observed[0]?.status, 'running')
  assert.ok(observed.some((event) => event.status === 'running' && event.deadlineAt !== undefined))
  assert.equal(observed.at(-1)?.status, 'timed-out')
  assert.equal(typeof observed.at(-1)?.durationMs, 'number')
})

void test('a never-settling observability callback cannot block tool completion', async () => {
  const result = await executeToolDefinition({
    name: 'UncooperativeObserver',
    description: 'observer fixture',
    inputSchema: z.object({}),
    execute: async () => ({ output: 'completed' })
  }, {}, {
    workspacePath: process.cwd(),
    sessionId: 'session-observer',
    approvalGate: async () => ({ outcome: 'allow', risk: 'read', reason: 'test' }),
    onToolCall: async () => await new Promise<void>(() => undefined)
  })
  assert.equal(result.output, 'completed')
})

void test('external cancellation settles an uncooperative tool', async () => {
  const controller = new AbortController()
  const promise = executeToolDefinition({
    name: 'CancelledFixture',
    description: 'cancel fixture',
    inputSchema: z.object({}),
    timeoutMs: 5_000,
    quiescenceGraceMs: 50,
    execute: async () => await new Promise<never>(() => undefined)
  }, {}, {
    workspacePath: process.cwd(),
    sessionId: 'session-cancelled',
    approvalGate: async () => ({ outcome: 'allow', risk: 'read', reason: 'test' }),
    abortSignal: controller.signal
  })
  controller.abort(new Error('user cancelled'))
  await assert.rejects(promise, /cancelled/i)
})

void test('host deadline waits for a cooperative tool to settle before reporting timed-out', async () => {
  let settled = false
  await assert.rejects(executeToolDefinition({
    name: 'CooperativeTimeout',
    description: 'settles shortly after its signal aborts',
    inputSchema: z.object({}),
    timeoutMs: 25,
    quiescenceGraceMs: 500,
    execute: async (_input, context) => {
      await new Promise<void>((resolve) => {
        context.abortSignal?.addEventListener('abort', () => setTimeout(resolve, 20), { once: true })
      })
      settled = true
      return { output: 'settled after abort' }
    }
  }, {}, {
    workspacePath: process.cwd(),
    sessionId: 'session-cooperative-timeout',
    approvalGate: async () => ({ outcome: 'allow', risk: 'read', reason: 'test' })
  }), /timed out/i)

  assert.equal(settled, true)
})

void test('external cancellation waits for a cooperative tool to settle before reporting cancelled', async () => {
  const controller = new AbortController()
  let settled = false
  const promise = executeToolDefinition({
    name: 'CooperativeCancel',
    description: 'settles shortly after its signal aborts',
    inputSchema: z.object({}),
    timeoutMs: 5_000,
    quiescenceGraceMs: 500,
    execute: async (_input, context) => {
      await new Promise<void>((resolve) => {
        context.abortSignal?.addEventListener('abort', () => setTimeout(resolve, 20), { once: true })
      })
      settled = true
      return { output: 'settled after abort' }
    }
  }, {}, {
    workspacePath: process.cwd(),
    sessionId: 'session-cooperative-cancel',
    approvalGate: async () => ({ outcome: 'allow', risk: 'read', reason: 'test' }),
    abortSignal: controller.signal
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  controller.abort(new Error('user cancelled'))
  await assert.rejects(promise, /cancelled/i)

  assert.equal(settled, true)
})

void test('tool observability reports running and completion with the provider tool call id', async () => {
  const events: Array<{ toolCallId?: string; status: string; durationMs?: number }> = []
  const toolSet = buildToolSet([{
    name: 'Observed',
    description: 'observable tool',
    inputSchema: z.object({ value: z.string() }),
    execute: async () => ({ output: 'observed' })
  }], {
    workspacePath: process.cwd(),
    sessionId: 'session-observed',
    approvalGate: async () => ({ outcome: 'allow', risk: 'read', reason: 'test approval' }),
    onToolCall: (event) => { events.push(event) }
  })

  const result = await (toolSet.Observed as unknown as {
    execute: (input: Record<string, unknown>, options: { toolCallId: string }) => Promise<{ output: string }>
  }).execute({ value: 'x' }, { toolCallId: 'call-observed' })

  assert.equal(result.output, 'observed')
  assert.deepEqual(events.map((event) => [event.toolCallId, event.status]), [
    ['call-observed', 'running'],
    ['call-observed', 'done']
  ])
  assert.equal(typeof events[1]?.durationMs, 'number')
})

void test('operation journal records intent before the tool body runs', async () => {
  const journal: OperationEvent[] = []
  const order: string[] = []
  await executeToolDefinition({
    name: 'Journaled',
    description: 'journal fixture',
    inputSchema: z.object({}),
    execute: async () => {
      order.push('body')
      return { output: 'ok' }
    }
  }, {}, {
    workspacePath: process.cwd(),
    sessionId: 'session-journal',
    runId: 'run-journal',
    approvalGate: async () => ({ outcome: 'allow', risk: 'read', reason: 'test' }),
    operationJournal: {
      append: (event) => {
        journal.push(event)
        order.push(event.type)
      }
    }
  })

  assert.deepEqual(order, [
    'tool-proposed',
    'approval-asked',
    'approval-decided',
    'tool-started',
    'body',
    'tool-result'
  ])
  assert.equal(journal[0]?.type, 'tool-proposed')
  assert.equal(journal.at(-1)?.type, 'tool-result')
  assert.equal((journal.at(-1) as { status?: string } | undefined)?.status, 'done')
})

void test('host guards can only tighten an allow into a deny', async () => {
  const bodyRan: string[] = []
  const result = await executeToolDefinition({
    name: 'Guarded',
    description: 'guard fixture',
    inputSchema: z.object({}),
    execute: async () => {
      bodyRan.push('body')
      return { output: 'ran' }
    }
  }, {}, {
    workspacePath: process.cwd(),
    sessionId: 'session-guarded',
    approvalGate: async () => ({ outcome: 'allow', risk: 'read', reason: 'test' }),
    guards: [() => 'fixture guard denial']
  })

  assert.equal(result.output, 'Tool call was denied.')
  assert.deepEqual(bodyRan, [])
})

void test('abstaining guards leave an allowed call untouched', async () => {
  const result = await executeToolDefinition({
    name: 'Unguarded',
    description: 'abstain fixture',
    inputSchema: z.object({}),
    execute: async () => ({ output: 'ran' })
  }, {}, {
    workspacePath: process.cwd(),
    sessionId: 'session-unguarded',
    approvalGate: async () => ({ outcome: 'allow', risk: 'read', reason: 'test' }),
    guards: [() => undefined, () => undefined]
  })

  assert.equal(result.output, 'ran')
})

void test('guards cannot re-allow a call that approval denied', async () => {
  const bodyRan: string[] = []
  const result = await executeToolDefinition({
    name: 'DeniedFirst',
    description: 'denied fixture',
    inputSchema: z.object({}),
    execute: async () => {
      bodyRan.push('body')
      return { output: 'ran' }
    }
  }, {}, {
    workspacePath: process.cwd(),
    sessionId: 'session-denied-first',
    approvalGate: async () => ({ outcome: 'deny', risk: 'read', reason: 'test deny' }),
    guards: [() => undefined]
  })

  assert.equal(result.output, 'Tool call was denied.')
  assert.deepEqual(bodyRan, [])
})
