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
