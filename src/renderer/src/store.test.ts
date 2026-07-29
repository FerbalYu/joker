import test from 'node:test'
import assert from 'node:assert/strict'
import { useStore } from './store'
import type { ChatMessage, StreamUsage } from '@shared/types'

void test('store restores sessions and clears transient stream state', () => {
  const message: ChatMessage = { id: 'm1', role: 'user', content: 'hello', createdAt: 1 }
  useStore.getState().setMessages([message])
  useStore.getState().startStream()
  useStore.getState().appendToken('partial')
  useStore.getState().resetTransientState()

  assert.deepEqual(useStore.getState().messages, [message])
  assert.equal(useStore.getState().streamText, '')
  assert.equal(useStore.getState().streaming, false)
  assert.equal(useStore.getState().streamStartedAt, null)
  assert.deepEqual(useStore.getState().pendingToolCalls, [])
})

void test('store persists usage on committed assistant messages', () => {
  useStore.getState().resetTransientState()
  useStore.getState().startStream()
  useStore.getState().appendToken('answer')
  const usage: StreamUsage = { inputTokens: 12, outputTokens: 4, totalTokens: 16, cacheReadTokens: 2 }
  const message = useStore.getState().commitStream('assistant-1', usage)
  assert.deepEqual(message?.usage, usage)
  assert.deepEqual(useStore.getState().messages.at(-1)?.usage, usage)
  useStore.getState().setLatestUsage(usage)
  useStore.getState().resetTransientState()
  assert.equal(useStore.getState().latestUsage, null)
})
void test('store resolves tool results by toolCallId', () => {
  useStore.getState().resetTransientState()
  useStore.getState().addPendingToolCall({ toolCallId: 'call-a', toolName: 'Read', input: {}, status: 'running' })
  useStore.getState().addPendingToolCall({ toolCallId: 'call-b', toolName: 'Read', input: {}, status: 'running' })
  useStore.getState().resolveToolCall('call-b', 'Read', 'second')

  const calls = useStore.getState().pendingToolCalls
  assert.equal(calls[0]?.status, 'running')
  assert.equal(calls[1]?.output, 'second')
  useStore.getState().resetTransientState()
})

void test('store records tool failures by toolCallId', () => {
  useStore.getState().resetTransientState()
  useStore.getState().addPendingToolCall({ toolCallId: 'call-a', toolName: 'GenerateImage', input: {}, status: 'running' })
  useStore.getState().addPendingToolCall({ toolCallId: 'call-b', toolName: 'GenerateImage', input: {}, status: 'running' })
  useStore.getState().failToolCall('call-b', 'GenerateImage', 'permission denied')

  const calls = useStore.getState().pendingToolCalls
  assert.equal(calls[0]?.status, 'running')
  assert.equal(calls[1]?.status, 'error')
  assert.equal(calls[1]?.output, 'permission denied')
  useStore.getState().resetTransientState()
})

void test('store finalizes every running tool after a fatal stream error', () => {
  useStore.getState().resetTransientState()
  useStore.getState().addPendingToolCall({ toolCallId: 'call-a', toolName: 'GenerateImage', input: {}, status: 'running' })
  useStore.getState().failRunningToolCalls('stream failed')
  assert.equal(useStore.getState().pendingToolCalls[0]?.status, 'error')
  assert.equal(useStore.getState().pendingToolCalls[0]?.output, 'stream failed')
  useStore.getState().resetTransientState()
})

void test('store keeps text before tools and text after tools as separate segments', () => {
  useStore.getState().resetTransientState()
  useStore.getState().startStream()
  useStore.getState().appendToken('可以，我先查一下。')
  useStore.getState().addPendingToolCall({ toolCallId: 'call-1', toolName: 'WebSearch', input: { query: 'grok' }, status: 'running' })
  useStore.getState().resolveToolCall('call-1', 'WebSearch', 'results')
  useStore.getState().appendToken('查完了。')

  const segments = useStore.getState().streamSegments
  assert.deepEqual(segments.map((segment) => segment.type), ['text', 'tools', 'text'])
  assert.equal(useStore.getState().streamText, '可以，我先查一下。查完了。')

  const message = useStore.getState().commitStream('assistant-seg')
  assert.deepEqual(message?.segments?.map((segment) => segment.type), ['text', 'tools', 'text'])
  assert.equal(message?.content, '可以，我先查一下。查完了。')
  assert.equal(message?.toolCalls?.length, 1)
  useStore.getState().resetTransientState()
})
