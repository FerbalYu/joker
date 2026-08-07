import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyToolRisk } from './risk'

void test('classifyToolRisk assigns intrinsic risks to built-in tools', () => {
  assert.equal(classifyToolRisk('Read'), 'read')
  assert.equal(classifyToolRisk('Write'), 'write_local')
  assert.equal(classifyToolRisk('Bash'), 'exec')
  assert.equal(classifyToolRisk('WebRead'), 'external')
})

void test('classifyToolRisk treats MCP, generated, and unknown tools conservatively', () => {
  assert.equal(classifyToolRisk('mcp_files_read', undefined, { type: 'mcp' }), 'external')
  assert.equal(classifyToolRisk('generated-read', undefined, { type: 'generated' }), 'external')
  assert.equal(classifyToolRisk('UnknownBuiltin'), 'external')
})

void test('declared tool risk overrides the default classification', () => {
  assert.equal(classifyToolRisk('CustomRead', 'read', { type: 'mcp' }), 'read')
})
