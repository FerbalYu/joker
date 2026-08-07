import test from 'node:test'
import assert from 'node:assert/strict'
import type { ChatMessage, SessionContextCheckpoint } from '@shared/types'
import { DEFAULT_CONTEXT_POLICY_VERSION } from '../shared/context'
import { hashChatMessageRange, projectSessionModelMessages } from './session-context'

function messages(): ChatMessage[] {
  return [
    { id: 'u-old', role: 'user', content: 'old request', createdAt: 1 },
    { id: 'a-old', role: 'assistant', content: 'old answer', createdAt: 2 },
    { id: 'u-recent', role: 'user', content: 'recent request', createdAt: 3 },
    { id: 'a-recent', role: 'assistant', content: 'recent answer', createdAt: 4 },
    { id: 'u-current', role: 'user', content: 'latest current user turn', createdAt: 5 }
  ]
}

function checkpoint(source: ChatMessage[]): SessionContextCheckpoint {
  return {
    version: 1,
    policyVersion: DEFAULT_CONTEXT_POLICY_VERSION,
    sourceFromMessageId: source[0].id,
    sourceUntilMessageId: source[1].id,
    sourceHash: hashChatMessageRange(source, source[0].id, source[1].id) ?? '',
    createdAt: 10,
    summary: {
      goal: '',
      confirmedFacts: ['Old fact'],
      decisions: ['Keep suffix'],
      filesRead: [],
      changesMade: [],
      failedAttempts: [],
      openTasks: ['Finish current turn'],
      criticalIdentifiers: ['u-current']
    },
    estimatedSourceTokens: 100,
    estimatedSummaryTokens: 20
  }
}

void test('valid checkpoint projection replaces only its source and retains suffix plus current user', () => {
  const source = messages()
  const projected = projectSessionModelMessages(source, checkpoint(source))
  assert.equal(projected.checkpointUsed, true)
  assert.equal(projected.messages[0]?.role, 'system')
  assert.match(String(projected.messages[0]?.content), /Old fact/)
  assert.deepEqual(projected.messages.slice(1).map((message) => message.content), [
    'recent request',
    'recent answer',
    'latest current user turn'
  ])
})

void test('invalid checkpoint falls back to all original messages', () => {
  const source = messages()
  const invalid = { ...checkpoint(source), sourceHash: '0'.repeat(64) }
  const projected = projectSessionModelMessages(source, invalid)
  assert.equal(projected.checkpointUsed, false)
  assert.deepEqual(projected.messages.map((message) => message.content), source.map((message) => message.content))
})

void test('projection never omits the latest current user even for a malformed source boundary', () => {
  const source = messages()
  const coveringCurrent = {
    ...checkpoint(source),
    sourceUntilMessageId: 'u-current',
    sourceHash: hashChatMessageRange(source, 'u-old', 'u-current') ?? ''
  }
  const projected = projectSessionModelMessages(source, coveringCurrent)
  assert.equal(projected.checkpointUsed, true)
  assert.equal(projected.messages.at(-1)?.content, 'latest current user turn')
})
