import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveAllowedMcpTools } from './capabilities'

void test('Skill MCP constraints use the intersection and empty allowlists grant nothing', () => {
  assert.deepEqual(resolveAllowedMcpTools([]), undefined)
  assert.deepEqual(resolveAllowedMcpTools([{ allowedMcpTools: ['a', 'b'] }]), ['a', 'b'])
  assert.deepEqual(resolveAllowedMcpTools([{ allowedMcpTools: ['a', 'b'] }, { allowedMcpTools: ['b', 'c'] }]), ['b'])
  assert.deepEqual(resolveAllowedMcpTools([{ allowedMcpTools: [] }]), [])
})
