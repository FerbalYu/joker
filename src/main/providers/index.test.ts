import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchProviderModels, mergeFetchedModels, testProviderModel } from './index'

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
