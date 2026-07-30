import test from 'node:test'
import assert from 'node:assert/strict'
import type { ChatMessage, ToolCallInfo } from '@shared/types'
import { latestTodoState } from './detail-todos'

function todoCall(
  todos: unknown,
  status: ToolCallInfo['status'] = 'done'
): ToolCallInfo {
  return {
    toolName: 'TodoWrite',
    input: { todos },
    status
  }
}

function assistantMessage(
  id: string,
  toolCalls: ToolCallInfo[],
  useSegments = true
): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    ...(useSegments
      ? { segments: [{ type: 'tools', tools: toolCalls }] }
      : { toolCalls }),
    createdAt: 1
  }
}

void test('latestTodoState prefers the latest current TodoWrite', () => {
  const state = latestTodoState([
    todoCall([{ content: 'old task', status: 'pending', priority: 'low' }]),
    { toolName: 'Read', input: {}, status: 'done' },
    todoCall([
      { content: 'finished', status: 'completed', priority: 'high' },
      { content: 'working', status: 'in_progress' }
    ], 'running')
  ])

  assert.deepEqual(state, {
    items: [
      { content: 'finished', status: 'completed', priority: 'high' },
      { content: 'working', status: 'in_progress', priority: 'medium' }
    ],
    completed: 1,
    total: 2
  })
})

void test('latestTodoState restores the newest historical TodoWrite from segments', () => {
  const messages = [
    assistantMessage('older', [todoCall([{ content: 'older task', status: 'pending' }])]),
    {
      id: 'user',
      role: 'user' as const,
      content: 'continue',
      createdAt: 2
    },
    assistantMessage('newer', [todoCall([{ content: 'newer task', status: 'completed' }])])
  ]

  const state = latestTodoState([], messages)

  assert.equal(state?.items[0]?.content, 'newer task')
  assert.equal(state?.completed, 1)
  assert.equal(state?.total, 1)
})

void test('latestTodoState supports legacy message toolCalls', () => {
  const state = latestTodoState([], [
    assistantMessage(
      'legacy',
      [todoCall([{ content: 'legacy task', status: 'in_progress', priority: 'low' }])],
      false
    )
  ])

  assert.deepEqual(state?.items, [
    { content: 'legacy task', status: 'in_progress', priority: 'low' }
  ])
})

void test('latestTodoState safely ignores malformed TodoWrite input', () => {
  assert.equal(latestTodoState([todoCall('not-an-array')]), null)
  assert.equal(latestTodoState([todoCall([{ content: 42, status: 'pending' }])]), null)
})
