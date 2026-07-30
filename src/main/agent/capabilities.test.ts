import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCapabilitySnapshot, resolveAllowedMcpTools } from './capabilities'

void test('Skill MCP constraints use the intersection and empty allowlists grant nothing', () => {
  assert.deepEqual(resolveAllowedMcpTools([]), undefined)
  assert.deepEqual(resolveAllowedMcpTools([{ allowedMcpTools: ['a', 'b'] }]), ['a', 'b'])
  assert.deepEqual(resolveAllowedMcpTools([{ allowedMcpTools: ['a', 'b'] }, { allowedMcpTools: ['b', 'c'] }]), ['b'])
  assert.deepEqual(resolveAllowedMcpTools([{ allowedMcpTools: [] }]), [])
})

void test('research capabilities enforce the bounded report workflow and disable MCP', () => {
  const snapshot = buildCapabilitySnapshot([], null, 'research')
  assert.deepEqual(snapshot.allowedMcpTools, [])
  assert.match(snapshot.systemPrompt ?? '', /first call TodoWrite/)
  assert.match(snapshot.systemPrompt ?? '', /WebSearch/)
  assert.match(snapshot.systemPrompt ?? '', /WebRead/)
  assert.match(snapshot.systemPrompt ?? '', /cross-check/)
  assert.match(snapshot.systemPrompt ?? '', /PresentResearchReport/)
  assert.match(snapshot.systemPrompt ?? '', /untrusted data/)
  assert.match(snapshot.systemPrompt ?? '', /at most 6 WebSearch calls and 12 WebRead calls/)
})
