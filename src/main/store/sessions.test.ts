import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  appendMessage,
  createSession,
  deleteSession,
  getSession,
  listSessions,
  replaceMessages,
  setSessionProject,
  setSessionsDataDirForTests
} from './sessions'

const dataDir = mkdtempSync(join(tmpdir(), 'joker-sessions-'))

before(() => setSessionsDataDirForTests(dataDir))
after(() => setSessionsDataDirForTests(null))

test('sessions start without a project and can bind then clear one', () => {
  const session = createSession('session project test')
  try {
    assert.equal(session.projectId, undefined)
    assert.equal(setSessionProject(session.id, 'missing-project'), false)
    assert.equal(setSessionProject(session.id, null), true)
    assert.equal(getSession(session.id)?.projectId, undefined)
  } finally {
    deleteSession(session.id)
  }
})

test('reads legacy JSON and writes the schema-versioned envelope', () => {
  const id = `legacy-${crypto.randomUUID()}`
  const legacy = { id, title: 'Legacy', createdAt: 1, updatedAt: 2, messages: [] }
  writeFileSync(join(dataDir, `${id}.json`), JSON.stringify(legacy), 'utf8')
  assert.deepEqual(getSession(id), legacy)
  assert.equal(appendMessage(id, { id: 'm1', role: 'user', content: 'hello', createdAt: 3 }), true)
  const stored = JSON.parse(readFileSync(join(dataDir, `${id}.json`), 'utf8'))
  assert.equal(stored.schemaVersion, 2)
  assert.equal(stored.data.id, id)
  deleteSession(id)
})

test('falls back to a valid backup when the primary file is corrupt', () => {
  const session = createSession('backup')
  const path = join(dataDir, `${session.id}.json`)
  const backup = { id: session.id, title: 'Recovered', createdAt: 1, updatedAt: 3, messages: [] }
  writeFileSync(`${path}.bak`, JSON.stringify({ schemaVersion: 1, data: backup }), 'utf8')
  writeFileSync(path, '{not-json', 'utf8')
  assert.deepEqual(getSession(session.id), backup)
  assert.equal(listSessions().some((item) => item.title === 'Recovered'), true)
  assert.equal(deleteSession(session.id), true)
  assert.equal(existsSync(path), false)
  assert.equal(existsSync(`${path}.bak`), false)
})

test('assistant usage and tool segments survive a session round trip', () => {
  const session = createSession('usage round trip')
  const assistant = {
    id: 'assistant-usage',
    role: 'assistant' as const,
    content: 'done',
    createdAt: 2,
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      noCacheTokens: 40,
      cacheReadTokens: 60,
      cacheWriteTokens: 5,
      stepCount: 3
    },
    segments: [{
      type: 'tools' as const,
      tools: [{
        toolCallId: 'call-agent',
        toolName: 'Agent',
        input: { prompt: 'inspect' },
        output: 'result',
        metadata: { usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 } },
        status: 'done' as const
      }]
    }]
  }
  try {
    assert.equal(appendMessage(session.id, assistant), true)
    assert.deepEqual(getSession(session.id)?.messages.at(-1), assistant)
  } finally {
    deleteSession(session.id)
  }
})

test('runMode survives round trips, legacy messages remain valid, and invalid modes are rejected', () => {
  const session = createSession('run mode validation')
  try {
    assert.equal(appendMessage(session.id, { id: 'legacy', role: 'user', content: 'legacy', createdAt: 1 }), true)
    assert.equal(appendMessage(session.id, { id: 'research-user', role: 'user', content: 'research', runMode: 'research', createdAt: 2 }), true)
    assert.equal(appendMessage(session.id, { id: 'research-assistant', role: 'assistant', content: 'report', runMode: 'research', createdAt: 3 }), true)
    assert.deepEqual(getSession(session.id)?.messages.map((message) => message.runMode), [undefined, 'research', 'research'])
    assert.equal(appendMessage(session.id, { id: 'invalid', role: 'user', content: 'bad', runMode: 'invalid' as never, createdAt: 4 }), false)
  } finally {
    deleteSession(session.id)
  }
})

test('large sessions restore bounded message data without temp-file leaks', () => {
  const session = createSession('large session')
  const messages = Array.from({ length: 10_000 }, (_, index) => ({
    id: `large-${index}`,
    role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
    content: `message-${index}-${'x'.repeat(80)}`,
    createdAt: index + 1
  }))
  assert.equal(replaceMessages(session.id, messages), true)
  const loaded = getSession(session.id)
  assert.ok(loaded)
  assert.equal(loaded.messages.length, messages.length)
  assert.equal(loaded.messages.at(-1)?.id, 'large-9999')
  assert.equal(readdirSync(dataDir).some((file) => file.endsWith('.tmp')), false)
  assert.equal(readdirSync(dataDir).some((file) => file.endsWith('.lock')), false)
  deleteSession(session.id)
})
