import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { streamText, tool } from 'ai'
import { z } from 'zod'
import { createLanguageModel, fetchProviderModels, mergeFetchedModels, testProviderModel } from './index'

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    await run(`http://127.0.0.1:${address.port}/v1`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

void test('mergeFetchedModels preserves existing enabled state', () => {
  const result = mergeFetchedModels(
    [{ id: 'kept', name: 'kept', enabled: false, maxContextTokens: 4096 }],
    [
      { id: 'kept', name: 'kept', enabled: true },
      { id: 'new', name: 'new', enabled: true }
    ]
  )

  assert.deepEqual(result.map(({ id, name, enabled, maxContextTokens }) => ({ id, name, enabled, maxContextTokens })), [
      { id: 'kept', name: 'kept', enabled: false, maxContextTokens: 4096 },
      { id: 'new', name: 'new', enabled: true, maxContextTokens: 262144 }
  ])
})

void test('fetchProviderModels parses and deduplicates data payloads', async () => {
  const originalFetch = globalThis.fetch
  let requestedUrl = ''
  let requestedAuth = ''
  globalThis.fetch = (async (input, init) => {
    requestedUrl = String(input)
    requestedAuth = new Headers(init?.headers).get('Authorization') ?? ''
    return new Response(JSON.stringify({ data: [{ id: 'z-model' }, { name: 'a-model' }, { id: 'z-model' }] }), { status: 200 })
  }) as typeof fetch

  try {
    const result = await fetchProviderModels({
      id: 'provider',
      name: 'Provider',
      apiFormat: 'chat-completions',
      modelsPath: '/v1/models',
      apiKey: 'secret',
      baseUrl: 'https://example.test/v1'
    })
    assert.equal(requestedUrl, 'https://example.test/v1/models')
    assert.equal(requestedAuth, 'Bearer secret')
    assert.deepEqual(result.models.map((model) => model.id), ['a-model', 'z-model'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

void test('testProviderModel sends a lightweight chat ping', async () => {
  const originalFetch = globalThis.fetch
  let request: RequestInit | undefined
  globalThis.fetch = (async (_input, init) => {
    request = init
    return new Response('{}', { status: 200 })
  }) as typeof fetch

  try {
    const result = await testProviderModel(
      {
        id: 'provider',
        name: 'Provider',
        apiFormat: 'chat-completions',
        apiKey: 'secret',
        baseUrl: 'https://example.test/v1'
      },
      'model-a'
    )
    assert.equal(result.success, true)
    assert.deepEqual(JSON.parse(String(request?.body)), {
      model: 'model-a',
      temperature: 0,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }]
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

void test('Anthropic provider test uses x-api-key and version headers', async () => {
  const originalFetch = globalThis.fetch
  let headers = new Headers()
  globalThis.fetch = (async (_input, init) => {
    headers = new Headers(init?.headers)
    return new Response('{}', { status: 200 })
  }) as typeof fetch

  try {
    const result = await testProviderModel({
      id: 'anthropic',
      name: 'Anthropic',
      apiFormat: 'anthropic-messages',
      apiKey: 'secret',
      baseUrl: 'https://example.test/v1'
    }, 'claude-test')
    assert.equal(result.success, true)
    assert.equal(headers.get('x-api-key'), 'secret')
    assert.equal(headers.get('anthropic-version'), '2023-06-01')
    assert.equal(headers.get('authorization'), null)
  } finally {
    globalThis.fetch = originalFetch
  }
})

void test('compatible streaming normalizes sparse tool-call indexes and preserves arguments', async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunks = [
      { index: 1, id: 'call-read', type: 'function', function: { name: 'Read', arguments: '{"path":"' } },
      { index: 1, function: { arguments: 'package.json"}' } },
      { index: 3, id: 'call-write', type: 'function', function: { name: 'Write', arguments: '{"path":"out.txt"}' } }
    ]
    for (const toolCall of chunks) {
      response.write(`data: ${JSON.stringify({ id: 'chatcmpl-tools', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta: { tool_calls: [toolCall] }, finish_reason: null }] })}\n\n`)
    }
    response.write(`data: ${JSON.stringify({ id: 'chatcmpl-tools', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
    response.end('data: [DONE]\n\n')
  }, async (baseUrl) => {
    const result = streamText({
      model: createLanguageModel({ provider: 'openai-compatible', apiFormat: 'chat-completions', model: 'fake-model', apiKey: 'secret', baseUrl }),
      prompt: 'perform tools',
      tools: {
        Read: tool({ description: 'Read', inputSchema: z.object({ path: z.string() }), execute: async () => 'read' }),
        Write: tool({ description: 'Write', inputSchema: z.object({ path: z.string() }), execute: async () => 'write' })
      }
    })
    const parts: Array<{ toolCallId: string; toolName: string; input: unknown }> = []
    for await (const part of result.fullStream) {
      if (part.type === 'tool-call') parts.push(part)
    }
    assert.deepEqual(parts.map((part) => ({ id: part.toolCallId, name: part.toolName, input: part.input })), [
      { id: 'call-read', name: 'Read', input: { path: 'package.json' } },
      { id: 'call-write', name: 'Write', input: { path: 'out.txt' } }
    ])
  })
})

void test('compatible streaming requests usage and maps cache details', async () => {
  let body: Record<string, unknown> = {}
  await withServer((request, response) => {
    void readJson(request).then((value) => {
      body = value
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        connection: 'keep-alive'
      })
      response.write(`data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 60 } } })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  }, async (baseUrl) => {
    const result = streamText({
      model: createLanguageModel({
        provider: 'openai-compatible',
        apiFormat: 'chat-completions',
        model: 'fake-model',
        apiKey: 'secret',
        baseUrl,
        includeUsage: true
      }),
      prompt: 'ping'
    })
    await result.consumeStream()
    assert.deepEqual(body['stream_options'], { include_usage: true })
    const usage = await result.usage
    assert.equal(usage.inputTokens, 100)
    assert.equal(usage.outputTokens, 10)
    assert.equal(usage.inputTokenDetails.noCacheTokens, 40)
    assert.equal(usage.inputTokenDetails.cacheReadTokens, 60)
    assert.equal(usage.inputTokenDetails.cacheWriteTokens, undefined)
  })
})

void test('compatible usage request can be disabled for incompatible gateways', async () => {
  let body: Record<string, unknown> = {}
  await withServer((request, response) => {
    void readJson(request).then((value) => {
      body = value
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ id: 'chatcmpl-2', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  }, async (baseUrl) => {
    const result = streamText({
      model: createLanguageModel({
        provider: 'openai-compatible',
        apiFormat: 'chat-completions',
        model: 'fake-model',
        apiKey: 'secret',
        baseUrl,
        includeUsage: false
      }),
      prompt: 'ping'
    })
    await result.consumeStream()
    assert.equal(body['stream_options'], undefined)
  })
})
