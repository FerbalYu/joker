import test from 'node:test'
import assert from 'node:assert/strict'
import type { ChatMessage } from '@shared/types'
import { toModelMessages } from './model-messages'

void test('modern assistant segments restore text, tool call, result, and later text in chronological order', () => {
  const messages: ChatMessage[] = [
    { id: 'u1', role: 'user', content: 'inspect it', createdAt: 1 },
    {
      id: 'a1',
      role: 'assistant',
      content: 'beforeafter',
      createdAt: 2,
      segments: [
        { type: 'text', text: 'before' },
        {
          type: 'tools',
          tools: [{
            toolCallId: 'call-read',
            toolName: 'Read',
            input: { file_path: 'a.ts' },
            output: 'file contents',
            status: 'done'
          }]
        },
        { type: 'text', text: 'after' }
      ]
    }
  ]

  const result = toModelMessages(messages)
  assert.deepEqual(result.map((message) => message.role), ['user', 'assistant', 'assistant', 'tool', 'assistant'])
  assert.equal(result[1].content, 'before')
  assert.equal(result[4].content, 'after')
  assert.deepEqual(result[2], {
    role: 'assistant',
    content: [{
      type: 'tool-call',
      toolCallId: 'call-read',
      toolName: 'Read',
      input: { file_path: 'a.ts' }
    }]
  })
  assert.deepEqual(result[3], {
    role: 'tool',
    content: [{
      type: 'tool-result',
      toolCallId: 'call-read',
      toolName: 'Read',
      output: { type: 'text', value: 'file contents' }
    }]
  })
})

void test('legacy toolCalls restore results after assistant content', () => {
  const result = toModelMessages([{
    id: 'legacy-a',
    role: 'assistant',
    content: 'legacy text',
    createdAt: 1,
    toolCalls: [{ toolName: 'Bash', input: { command: 'pwd' }, output: 'C:/work', status: 'done' }]
  }])

  assert.deepEqual(result.map((message) => message.role), ['assistant', 'assistant', 'tool'])
  const call = result[1]
  const toolResult = result[2]
  assert.ok(call.role === 'assistant' && Array.isArray(call.content))
  assert.ok(toolResult.role === 'tool')
  const callPart = call.content.find((part) => part.type === 'tool-call')
  const resultPart = toolResult.content.find((part) => part.type === 'tool-result')
  assert.ok(callPart?.type === 'tool-call')
  assert.ok(resultPart?.type === 'tool-result')
  assert.equal(callPart.toolCallId, 'legacy-a-1-0')
  assert.equal(resultPart.toolCallId, 'legacy-a-1-0')
})

void test('multiple tool groups use stable generated IDs and preserve group order', () => {
  const message = {
    id: 'assistant-groups',
    role: 'assistant',
    content: '',
    createdAt: 1,
    segments: [
      { type: 'tools' as const, tools: [{ toolName: 'Read', input: {}, output: 'one', status: 'done' as const }] },
      { type: 'text' as const, text: 'middle' },
      { type: 'tools' as const, tools: [{ toolName: 'Grep', input: {}, output: 'two', status: 'done' as const }] }
    ]
  }
  assert.deepEqual(toModelMessages([message]), toModelMessages([message]))
  assert.deepEqual(toModelMessages([message]).map((item) => item.role), ['assistant', 'tool', 'assistant', 'assistant', 'tool'])
})

void test('error tool results become error-text outputs', () => {
  const result = toModelMessages([{
    id: 'assistant-error',
    role: 'assistant',
    content: '',
    createdAt: 1,
    segments: [{
      type: 'tools',
      tools: [{ toolCallId: 'call-error', toolName: 'Read', input: {}, output: 'permission denied', status: 'error' }]
    }]
  }])
  const toolMessage = result.find((message) => message.role === 'tool')
  assert.ok(toolMessage?.role === 'tool')
  const errorPart = toolMessage.content.find((part) => part.type === 'tool-result')
  assert.ok(errorPart?.type === 'tool-result')
  assert.deepEqual(errorPart.output, { type: 'error-text', value: 'permission denied' })
})

void test('denied tool results become error-text outputs', () => {
  const result = toModelMessages([{
    id: 'assistant-denied',
    role: 'assistant',
    content: '',
    createdAt: 1,
    segments: [{ type: 'tools', tools: [{ toolCallId: 'call-denied', toolName: 'Write', input: {}, output: 'Tool call was denied.', status: 'denied' }] }]
  }])
  const toolMessage = result.find((message) => message.role === 'tool')
  assert.ok(toolMessage?.role === 'tool')
  const errorPart = toolMessage.content.find((part) => part.type === 'tool-result')
  assert.ok(errorPart?.type === 'tool-result')
  assert.deepEqual(errorPart.output, { type: 'error-text', value: 'Tool call was denied.' })
})

void test('running historical tools receive an interrupted terminal result', () => {
  const result = toModelMessages([{
    id: 'assistant-running',
    role: 'assistant',
    content: '',
    createdAt: 1,
    segments: [{ type: 'tools', tools: [{ toolName: 'Read', input: {}, status: 'running' }] }]
  }])
  assert.deepEqual(result.map((message) => message.role), ['assistant', 'tool'])
  const toolMessage = result[1]
  assert.ok(toolMessage?.role === 'tool')
  const interruptedPart = toolMessage.content[0]
  assert.ok(interruptedPart?.type === 'tool-result')
  assert.deepEqual(interruptedPart.output, {
    type: 'error-text',
    value: 'Tool execution was interrupted before returning a result.'
  })
})

void test('failed historical tools without output receive a terminal failure result', () => {
  const result = toModelMessages([{
    id: 'assistant-failed',
    role: 'assistant',
    content: '',
    createdAt: 1,
    segments: [{ type: 'tools', tools: [{ toolName: 'Read', input: {}, status: 'error' }] }]
  }])
  const toolMessage = result[1]
  assert.ok(toolMessage?.role === 'tool')
  const failurePart = toolMessage.content[0]
  assert.ok(failurePart?.type === 'tool-result')
  assert.deepEqual(failurePart.output, {
    type: 'error-text',
    value: 'Tool failed before returning a result.'
  })
})

void test('invalid message roles are rejected before reaching the model', () => {
  assert.throws(() => toModelMessages([{ id: 'bad', role: 'tool', content: 'invalid', createdAt: 1 }]), /Invalid message role/)
})

void test('user image parts are restored as model file parts', () => {
  const result = toModelMessages([{
    id: 'user-image',
    role: 'user',
    content: 'look',
    createdAt: 1,
    parts: [
      { type: 'text', text: 'look' },
      { type: 'image', data: 'iVBORw0KGgo=', mediaType: 'image/png' }
    ]
  }])
  assert.equal(result[0].role, 'user')
  assert.ok(Array.isArray(result[0].content))
  assert.deepEqual(result[0].content.map((part) => part.type), ['text', 'file'])
})
