import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sanitizeAuditValue, setToolAuditPathForTests, truncatePreview, writeToolAudit } from './audit'

void test('tool audit recursively redacts secrets and large bodies', () => {
  assert.deepEqual(sanitizeAuditValue({
    apiKey: 'secret-key',
    headers: { Authorization: 'Bearer secret', Cookie: 'sid=secret' },
    nested: { password: 'pw', body: 'large request body' },
    url: 'https://example.com'
  }), {
    apiKey: '[redacted]',
    headers: { Authorization: '[redacted]', Cookie: '[redacted]' },
    nested: { password: '[redacted]', body: '[redacted body]' },
    url: 'https://example.com'
  })
})

void test('tool audit redacts sensitive argument keys', () => {
  assert.deepEqual(sanitizeAuditValue({
    command: 'echo $API_KEY',
    prompt: 'system instructions with secrets',
    oldString: 'old code with api key',
    newString: 'new code'
  }), {
    command: '[redacted]',
    prompt: '[redacted]',
    oldString: '[redacted]',
    newString: '[redacted]'
  })
})

void test('tool audit redacts bearer tokens and api keys in string values', () => {
  assert.equal(
    sanitizeAuditValue('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9 secret sk-testkeyabc123def456ghi789'),
    'Authorization: [redacted] secret [redacted]'
  )
})

void test('tool audit redacts api keys in url query params', () => {
  assert.equal(
    sanitizeAuditValue('https://api.example.com/v1/chat?api_key=sk-secret123456789012345678'),
    'https://api.example.com/v1/chat?api_key=[redacted]'
  )
})

void test('tool audit bounds result previews', () => {
  const preview = truncatePreview('x'.repeat(1000))
  assert.equal(preview.length, 500)
  assert.match(preview, /\.\.\.$/)
})

void test('writeToolAudit persists a safe JSONL event', () => {
  const root = mkdtempSync(join(tmpdir(), 'joker-tool-audit-'))
  const path = join(root, 'audit.jsonl')
  setToolAuditPathForTests(path)
  try {
    writeToolAudit({
      sessionId: 'session-a',
      runId: 'run-a',
      tool: 'WebRead',
      source: 'builtin',
      risk: 'external',
      stage: 'finished',
      status: 'success',
      arguments: { authorization: 'Bearer secret', url: 'https://example.com' },
      resultPreview: 'ok'
    })
    const event = JSON.parse(readFileSync(path, 'utf8').trim()) as Record<string, unknown>
    assert.equal(event.sessionId, 'session-a')
    assert.deepEqual(event.arguments, { authorization: '[redacted]', url: 'https://example.com' })
    assert.equal(typeof event.timestamp, 'string')
  } finally {
    setToolAuditPathForTests(null)
    rmSync(root, { recursive: true, force: true })
  }
})

void test('writeToolAudit rotates instead of truncating when exceeding size limit', () => {
  const root = mkdtempSync(join(tmpdir(), 'joker-tool-audit-rot-'))
  const path = join(root, 'audit.jsonl')
  const backup = `${path}.1`
  setToolAuditPathForTests(path)
  try {
    // Fill the audit file past the 512 KiB limit (~900 entries at ~600 bytes each).
    for (let i = 0; i < 1000; i++) {
      writeToolAudit({
        sessionId: 'session-rot',
        tool: 'Bash',
        source: 'builtin',
        risk: 'exec',
        stage: 'finished',
        status: 'success',
        arguments: { command: 'echo test' },
        resultPreview: 'x'.repeat(400)
      })
    }
    assert.ok(existsSync(backup), 'rotated backup file should exist')
    assert.ok(existsSync(path), 'new audit file should exist after rotation')
    assert.ok(statSync(path).size <= 512 * 1024, 'active audit file should be within limit')
  } finally {
    setToolAuditPathForTests(null)
    rmSync(root, { recursive: true, force: true })
  }
})
