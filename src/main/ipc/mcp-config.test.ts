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
  assert.throws(() => normalizeHeaders(Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`X-${index}`, 'x'.repeat(4096)]))), /too large/)
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

void test('validateServerConfig keeps stdio configuration isolated from user filesystem', () => {
  assert.deepEqual(validateServerConfig({
    id: 'local-tool', name: ' Local Tool ', transport: 'stdio', command: 'node', args: ['server.mjs'], enabled: false
  }), {
    id: 'local-tool', name: 'Local Tool', enabled: false, transport: 'stdio', command: 'node', args: ['server.mjs'], url: undefined, headers: undefined, autoConnect: true,
    trustState: 'untrusted', trustedFingerprint: undefined, permission: 'deny', initializeTimeoutMs: 30_000, callTimeoutMs: 30_000, recovery: undefined
  })
})
