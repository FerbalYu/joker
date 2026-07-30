import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeHeaders, validateServerConfig } from './mcp-config'

void test('normalizeHeaders rejects CRLF and enforces limits', () => {
  assert.deepEqual(normalizeHeaders({ Authorization: 'Bearer token', 'X-Test': 'ok' }), {
    Authorization: 'Bearer token',
    'X-Test': 'ok'
  })
  assert.throws(() => normalizeHeaders({ Authorization: 'bad\r\nInjected: yes' }), /header value/)
  assert.throws(() => normalizeHeaders({ ['x'.repeat(81)]: 'value' }), /header name/)
  assert.throws(() => normalizeHeaders(Object.fromEntries(Array.from({ length: 31 }, (_, index) => [`X-${index}`, 'v']))), /Too many/)
  assert.throws(() => normalizeHeaders({ Authorization: 'x'.repeat(32 * 1024) }), /header value|too large/)
})

void test('validateServerConfig normalizes headers and rejects embedded HTTP credentials', () => {
  const server = validateServerConfig({
    id: 'mcp-test',
    name: ' Test ',
    enabled: true,
    transport: 'http',
    url: 'https://example.com/mcp',
    headers: { Authorization: 'Bearer token' }
  })
  assert.equal(server.name, 'Test')
  assert.deepEqual(server.headers, { Authorization: 'Bearer token' })
  assert.throws(() => validateServerConfig({
    id: 'mcp-test', name: 'Test', transport: 'http', url: 'https://user:pass@example.com/mcp'
  }), /credentials/)
})
