import test from 'node:test'
import assert from 'node:assert/strict'
import { filterMcpToolEntries, generatedMcpToolName, mcpToolKeys } from './mcp-bridge'

const entries = [
  { serverId: 'files', serverName: 'Files', tool: { name: 'read', inputSchema: {} } },
  { serverId: 'files', serverName: 'Files', tool: { name: 'write', inputSchema: {} } },
  { serverId: 'other-server', serverName: 'Other', tool: { name: 'read', inputSchema: {} } }
]

void test('MCP allowlist matches exact serverId/tool.name or generated name only', () => {
  assert.equal(generatedMcpToolName('files', 'read'), 'mcp_files_read')
  assert.deepEqual(mcpToolKeys(entries[0]!), ['files/read', 'mcp_files_read'])
  assert.deepEqual(filterMcpToolEntries(entries, ['files/read']).map((entry) => entry.tool.name), ['read'])
  assert.deepEqual(filterMcpToolEntries(entries, ['mcp_files_read']).map((entry) => entry.tool.name), ['read'])
  assert.deepEqual(filterMcpToolEntries(entries, ['read']).map((entry) => entry.tool.name), [])
  assert.deepEqual(filterMcpToolEntries(entries, ['files/*']).map((entry) => entry.tool.name), [])
})

void test('MCP filtering preserves all tools only when there is no Skill constraint', () => {
  assert.equal(filterMcpToolEntries(entries).length, 3)
  assert.equal(filterMcpToolEntries(entries, []).length, 0)
})
