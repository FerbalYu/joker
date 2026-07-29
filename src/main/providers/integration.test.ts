import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { fetchProviderModels, requestJson, testProviderModel } from './index'

async function withFakeProvider(handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void, run: (baseUrl: string) => Promise<void>): Promise<void> {
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

function provider(baseUrl: string, apiFormat: 'chat-completions' | 'responses' | 'anthropic-messages' = 'chat-completions') {
  return { id: 'fake', name: 'Fake', apiFormat, apiKey: 'secret', baseUrl }
}

void test('fake Provider HTTP contract covers URL, authorization, and model payload', async () => {
  await withFakeProvider((request, response) => {
    assert.equal(request.url, '/v1/models')
    assert.equal(request.headers.authorization, 'Bearer secret')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'zeta' }, { name: 'alpha' }, { id: 'zeta' }] }))
  }, async (baseUrl) => {
    const result = await fetchProviderModels({ ...provider(baseUrl), modelsPath: '/v1/models' })
    assert.deepEqual(result.models.map((model) => model.id), ['alpha', 'zeta'])
  })

  await withFakeProvider((request, response) => {
    assert.equal(request.method, 'POST')
    assert.equal(request.url, '/v1/chat/completions')
    assert.equal(request.headers.authorization, 'Bearer secret')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{}')
  }, async (baseUrl) => {
    const result = await testProviderModel(provider(baseUrl), 'fake-model')
    assert.equal(result.success, true)
  })
})

void test('fake Provider HTTP contract maps status and malformed JSON errors', async () => {
  await withFakeProvider((_request, response) => {
    response.writeHead(401)
    response.end('unauthorized')
  }, async (baseUrl) => {
    const result = await testProviderModel(provider(baseUrl), 'fake-model')
    assert.equal(result.success, false)
    assert.equal(result.message, 'API 密钥无效或没有权限')
  })

  await withFakeProvider((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{not-json')
  }, async (baseUrl) => {
    await assert.rejects(fetchProviderModels(provider(baseUrl)), /无法解析的 JSON/)
  })
})

void test('fake Provider HTTP contract reports timeout without external network', async () => {
  const server: Server = createServer(() => {
    // Keep the request open. The provider helper owns the abort timeout.
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    await assert.rejects(requestJson(`http://127.0.0.1:${address.port}/slow`, 'secret', { method: 'GET' }, 25), /请求超时/)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
