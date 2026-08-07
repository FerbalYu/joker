import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ChatMessage } from '@shared/types'
import type { LanguageModel } from 'ai'
import { appendMessage, createSession, deleteSession, getSession, setSessionsDataDirForTests } from '../store/sessions'
import { compactSession } from './session-compact'

const dataDir = mkdtempSync(join(tmpdir(), 'joker-compact-'))
before(() => setSessionsDataDirForTests(dataDir))
after(() => setSessionsDataDirForTests(null))

function v3Usage() {
  return {
    inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 20, text: 20, reasoning: 0 }
  }
}

function summaryModel(onGenerate?: () => void): LanguageModel {
  return {
    specificationVersion: 'v3',
    provider: 'test',
    modelId: 'compact-summary',
    supportedUrls: {},
    doGenerate: async () => {
      onGenerate?.()
      return {
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: v3Usage(),
        response: { id: 'summary', modelId: 'compact-summary', timestamp: new Date(0) },
        content: [{ type: 'text', text: JSON.stringify({
          confirmedFacts: ['The repository is E:/joker'],
          decisions: ['Preserve original messages'],
          filesRead: ['E:/joker/src/main/stream.ts'],
          changesMade: [],
          failedAttempts: [],
          openTasks: ['Run validation'],
          criticalIdentifiers: ['DEFAULT_CONTEXT_POLICY_VERSION']
        }) }],
        warnings: []
      }
    },
    doStream: async () => { throw new Error('not used') }
  } as unknown as LanguageModel
}

function longHistory(): ChatMessage[] {
  return [
    { id: 'u1', role: 'user', content: 'old request ' + 'a'.repeat(5_000), createdAt: 1 },
    { id: 'a1', role: 'assistant', content: 'old response ' + 'b'.repeat(5_000), createdAt: 2 },
    { id: 'u2', role: 'user', content: 'older request ' + 'c'.repeat(5_000), createdAt: 3 },
    { id: 'a2', role: 'assistant', content: 'older response ' + 'd'.repeat(5_000), createdAt: 4 },
    { id: 'u3', role: 'user', content: 'recent request ' + 'e'.repeat(1_000), createdAt: 5 },
    { id: 'a3', role: 'assistant', content: 'recent response ' + 'f'.repeat(1_000), createdAt: 6 },
    { id: 'u4', role: 'user', content: 'latest current turn', createdAt: 7 }
  ]
}

void test('compact leaves short history unchanged without calling the model', async () => {
  const session = createSession('compact short')
  let calls = 0
  try {
    appendMessage(session.id, { id: 'u-short', role: 'user', content: 'hello', createdAt: 1 })
    const before = getSession(session.id)?.messages
    const result = await compactSession(session.id, { model: summaryModel(() => { calls += 1 }) })
    assert.equal(result.success, true)
    assert.equal(result.changed, false)
    assert.equal(result.error, 'not-enough-history')
    assert.equal(calls, 0)
    assert.deepEqual(getSession(session.id)?.messages, before)
    assert.equal(getSession(session.id)?.contextCheckpoint, undefined)
  } finally {
    deleteSession(session.id)
  }
})

void test('successful compact saves a checkpoint and preserves every original message', async () => {
  const session = createSession('compact success')
  try {
    const original = longHistory()
    for (const message of original) assert.equal(appendMessage(session.id, message), true)
    const result = await compactSession(session.id, { model: summaryModel(), now: () => 123 })
    const stored = getSession(session.id)
    assert.equal(result.success, true)
    assert.equal(result.changed, true)
    assert.ok(result.afterTokens < result.beforeTokens)
    assert.deepEqual(stored?.messages, original)
    assert.equal(stored?.contextCheckpoint?.createdAt, 123)
    assert.equal(stored?.contextCheckpoint?.summary.goal, '')
    assert.deepEqual(stored?.contextCheckpoint?.summary.openTasks, ['Run validation'])
    assert.equal(stored?.contextCheckpoint?.sourceUntilMessageId, 'a2')
  } finally {
    deleteSession(session.id)
  }
})

void test('compact rejects a stale concurrent write after summary generation', async () => {
  const session = createSession('compact stale')
  try {
    for (const message of longHistory()) appendMessage(session.id, message)
    const concurrent: ChatMessage = { id: 'u-concurrent', role: 'user', content: 'concurrent update', createdAt: 8 }
    const result = await compactSession(session.id, {
      model: summaryModel(() => { assert.equal(appendMessage(session.id, concurrent), true) })
    })
    assert.equal(result.success, false)
    assert.equal(result.changed, false)
    assert.equal(result.error, 'stale-session')
    assert.equal(getSession(session.id)?.contextCheckpoint, undefined)
    assert.equal(getSession(session.id)?.messages.at(-1)?.id, concurrent.id)
  } finally {
    deleteSession(session.id)
  }
})
