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
    approvalGate: async () => true
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
    approvalGate: async () => true
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
    approvalGate: async () => false
  })

  const result = await (toolSet.Denied as unknown as { execute: (input: Record<string, unknown>) => Promise<{ output: string }> }).execute({})
  assert.equal(executed, false)
  assert.equal(result.output, 'Tool call was denied by user.')
})
