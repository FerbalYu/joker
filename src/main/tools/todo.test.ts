import test from 'node:test'
import assert from 'node:assert/strict'
import { clearTodos, getTodos, todoTool } from './todo'
import type { ToolContext } from './registry'

void test('TodoWrite keeps state isolated by sessionId', async () => {
  clearTodos()
  const context: ToolContext = {
    workspacePath: process.cwd(),
    sessionId: 'session-a',
    approvalGate: async () => ({ outcome: 'allow', risk: 'read', reason: 'test approval' })
  }
  await todoTool.execute({ todos: [{ content: 'A', status: 'pending', priority: 'high' }] }, context)
  await todoTool.execute({ todos: [{ content: 'B', status: 'completed', priority: 'low' }] }, { ...context, sessionId: 'session-b' })

  assert.equal(getTodos('session-a')[0]?.content, 'A')
  assert.equal(getTodos('session-b')[0]?.content, 'B')
  assert.deepEqual(getTodos('default'), [])
  clearTodos()
})
