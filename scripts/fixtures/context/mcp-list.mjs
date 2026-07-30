const SENTINELS = [
  'server_id=mcp-prod-017',
  'tool_id=inventory.delete',
  'isError=true',
  'error_code=MCP_DENY_403',
  'permission=deny'
]

const servers = Array.from({ length: 140 }, (_, serverIndex) => ({
  serverId: serverIndex === 17 ? 'mcp-prod-017' : `mcp-${String(serverIndex).padStart(3, '0')}`,
  status: 'connected',
  permission: serverIndex === 17 ? 'deny' : 'allow',
  tools: Array.from({ length: 14 }, (_, toolIndex) => ({
    toolId: serverIndex === 17 && toolIndex === 9 ? 'inventory.delete' : `resource.${toolIndex}`,
    description: 'Deterministic MCP qualification tool with repeated schema text',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, limit: { type: 'number' } }, required: ['id'] },
    ...(serverIndex === 17 && toolIndex === 9 ? { isError: true, errorCode: 'MCP_DENY_403' } : {})
  }))
}))

export default {
  id: 'mcp-list',
  title: 'Large MCP server and tool inventory',
  category: 'mcp-list',
  minimumNetSavingRatio: 0,
  sentinels: SENTINELS,
  messages: [
    { role: 'user', content: 'Review the MCP inventory. Protect server/tool IDs, error state, error code, and denied permission.' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-mcp-list', toolName: 'McpListTools', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-mcp-list', toolName: 'McpListTools', output: { type: 'json', value: { servers } } }] },
    { role: 'user', content: 'Investigate server_id=mcp-prod-017 tool_id=inventory.delete where isError=true, error_code=MCP_DENY_403, permission=deny.' }
  ]
}
