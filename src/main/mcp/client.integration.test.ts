import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { mcpManager } from './client'
import { validateServerConfig } from '../ipc/mcp-config'
import { mcpIdentityFingerprint } from './identity'

const stdioScript = `
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { writeFileSync } from 'node:fs'
const marker = process.argv[1]
writeFileSync(marker, String(process.pid), 'utf8')
const server = new McpServer({ name: 'joker-contract-stdio', version: '1.0.0' })
server.registerTool('echo', { description: 'Echo a message', inputSchema: { message: z.string() } }, async ({ message }) => ({ content: [{ type: 'text', text: message }] }))
server.registerTool('fail', { description: 'Return a tool error', inputSchema: { message: z.string() } }, async ({ message }) => ({ isError: true, content: [{ type: 'text', text: message }] }))
await server.connect(new StdioServerTransport())
`

function uniqueId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

async function waitForProcessExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

async function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

void test('MCP stdio runtime connects, lists, calls, reports errors, and cleans up the child', async () => {
  const marker = `${process.env.TEMP ?? process.env.TMP ?? '.'}/joker-mcp-${crypto.randomUUID()}.pid`
  const id = uniqueId('stdio')
  const config = validateServerConfig({
    id,
    name: 'Contract stdio',
    enabled: true,
    transport: 'stdio',
    command: process.execPath,
    args: ['--input-type=module', '-e', stdioScript, marker],
    autoConnect: true,
    trustState: 'trusted',
    trustedFingerprint: mcpIdentityFingerprint({ transport: 'stdio', command: process.execPath, args: ['--input-type=module', '-e', stdioScript, marker] }),
    permission: 'allow'
  })

  try {
    await mcpManager.connect(config)
    const runtime = mcpManager.getRuntime(id)
    assert.equal(runtime?.status, 'connected')
    assert.equal(runtime?.toolCount, 2)
    assert.deepEqual(mcpManager.getAllTools().filter((item) => item.serverId === id).map((item) => item.tool.name).sort(), ['echo', 'fail'])

    const result = await mcpManager.callTool(id, 'echo', { message: 'hello stdio' }) as { content: Array<{ type: string; text: string }> }
    assert.equal(result.content[0]?.text, 'hello stdio')
    const failed = await mcpManager.callTool(id, 'fail', { message: 'expected failure' }) as { isError?: boolean }
    assert.equal(failed.isError, true)

    const markerDeadline = Date.now() + 2_000
    while (Date.now() < markerDeadline) {
      try {
        const { readFile } = await import('node:fs/promises')
        if ((await readFile(marker, 'utf8')).trim()) break
      } catch {
        // The child may not have written its marker yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const { readFile, rm } = await import('node:fs/promises')
    const pid = Number((await readFile(marker, 'utf8')).trim())
    assert.ok(Number.isInteger(pid) && pid > 0)
    await mcpManager.disconnect(id)
    assert.equal(mcpManager.getRuntime(id)?.status, 'disconnected')
    assert.equal(await waitForProcessExit(pid), true)
    await rm(marker, { force: true })
  } finally {
    await mcpManager.disconnect(id).catch(() => undefined)
    const { rm } = await import('node:fs/promises')
    await rm(marker, { force: true }).catch(() => undefined)
  }
})

void test('MCP streamable HTTP fails closed for private network URLs before connecting', async () => {
  const id = uniqueId('http')
  const receivedHeaders: string[] = []
  const methods: string[] = []
  const server = createServer((request, response) => {
    methods.push(request.method ?? '')
    receivedHeaders.push(request.headers.authorization ?? '')
    if (request.method === 'GET') {
      response.writeHead(405).end()
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405).end()
      return
    }
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      let message: { id?: string | number; method?: string; params?: Record<string, unknown> }
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof message
      } catch {
        response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }))
        return
      }
      if (!message.method || message.id === undefined) {
        response.writeHead(202).end()
        return
      }
      let result: unknown
      if (message.method === 'initialize') {
        result = {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'joker-contract-http', version: '1.0.0' }
        }
      } else if (message.method === 'tools/list') {
        result = { tools: [{ name: 'echo', description: 'Echo a message', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } }] }
      } else if (message.method === 'tools/call') {
        const args = (message.params?.arguments ?? {}) as { message?: string }
        result = { content: [{ type: 'text', text: args.message ?? '' }] }
      } else {
        response.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' }, id: message.id }))
        return
      }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const config = validateServerConfig({
    id,
    name: 'Contract HTTP',
    enabled: true,
    transport: 'http',
    url: `http://127.0.0.1:${address.port}/mcp`,
    headers: { Authorization: 'Bearer contract-secret', 'X-Contract-Test': 'yes' },
    trustState: 'trusted',
    trustedFingerprint: mcpIdentityFingerprint({ transport: 'http', url: `http://127.0.0.1:${address.port}/mcp` }),
    permission: 'allow'
  })

  try {
    await assert.rejects(mcpManager.connect(config), /local, private, or non-public/)
    assert.equal(mcpManager.getRuntime(id)?.status, 'error')
    assert.equal(methods.length, 0)
    assert.equal(receivedHeaders.length, 0)
  } finally {
    await mcpManager.disconnect(id).catch(() => undefined)
    await closeHttpServer(server)
  }
})
