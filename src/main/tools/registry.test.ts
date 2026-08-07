import test from 'node:test'
import assert from 'node:assert/strict'
import { buildToolSet, type ToolContext } from './registry'
import { z } from 'zod'

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
      runtimeQualificationLevel: 'L2'
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
