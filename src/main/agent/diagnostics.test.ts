import test from 'node:test'
import assert from 'node:assert/strict'
import { formatSafeError } from './diagnostics'

void test('formatSafeError redacts credentials and keeps useful status', () => {
  const error = {
    name: 'APICallError',
    message: 'Authorization: Bearer super-secret token=hidden https://user:pass@example.test/v1',
    statusCode: 403,
    isRetryable: false
  }
  const formatted = formatSafeError(error)
  assert.match(formatted, /HTTP 403/)
  assert.match(formatted, /Authorization: \[redacted\]/)
  assert.match(formatted, /token=\[redacted\]/)
  assert.equal(formatted.includes('15[redacted]'), false)
  assert.equal(formatted.includes('super-secret'), false)
  assert.equal(formatted.includes('hidden'), false)
  assert.equal(formatted.includes('user:pass'), false)
})
