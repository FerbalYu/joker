import test from 'node:test'
import assert from 'node:assert/strict'
import type { ModelMessage } from 'ai'
import { estimateContextTokens, compressContext } from './context'

void test('estimateContextTokens scales with text size', () => {
  const short: ModelMessage[] = [{ role: 'user', content: '1234' }]
  const long: ModelMessage[] = [{ role: 'user', content: '1'.repeat(400) }]
  assert.ok(estimateContextTokens(long) > estimateContextTokens(short))
})

void test('below the compression threshold remains unchanged', async () => {
  const messages: ModelMessage[] = [{ role: 'user', content: 'hello' }]
  assert.deepEqual(await compressContext(messages, { maxContextTokens: 20000 }), messages)
})
