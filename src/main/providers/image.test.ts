import test from 'node:test'
import assert from 'node:assert/strict'
import type { ImageProviderEntry } from '@shared/types'
import { fetchImageProviderModels, generateImage, parseFirstImage, parseModelIds, testImageProvider } from './image'

const baseConfig: ImageProviderEntry = {
  id: 'image-test',
  enabled: true,
  name: 'Images',
  protocol: 'openai-images',
  baseUrl: 'https://image.example.test/v1',
  apiKey: 'top-secret-key',
  model: 'image-model',
  modelsPath: '/models',
  defaultSize: '1024x1024',
  defaultAspectRatio: '1:1',
  defaultResolution: '1k',
  responseFormat: 'url'
}

void test('generateImage sends OpenAI Images request and parses URL output', async () => {
  const originalFetch = globalThis.fetch
  let requestUrl = ''
  let requestInit: RequestInit | undefined
  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input)
    requestInit = init
    return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example.test/image.png', mime_type: 'image/png' }] }), { status: 200 })
  }) as typeof fetch

  try {
    const result = await generateImage(baseConfig, { prompt: 'Draw a quiet lake' })
    assert.equal(requestUrl, 'https://image.example.test/v1/images/generations')
    assert.equal(new Headers(requestInit?.headers).get('Authorization'), 'Bearer top-secret-key')
    assert.deepEqual(JSON.parse(String(requestInit?.body)), {
      model: 'image-model',
      prompt: 'Draw a quiet lake',
      n: 1,
      response_format: 'url',
      size: '1024x1024'
    })
    assert.deepEqual(result, {
      url: 'https://cdn.example.test/image.png',
      base64: undefined,
      mediaType: 'image/png'
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

void test('generateImage sends Grok aspect ratio and resolution', async () => {
  const originalFetch = globalThis.fetch
  let body: Record<string, unknown> = {}
  globalThis.fetch = (async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=', mime_type: 'image/webp' }] }), { status: 200 })
  }) as typeof fetch

  try {
    const result = await generateImage(
      { ...baseConfig, protocol: 'grok-images', responseFormat: 'b64_json' },
      { prompt: 'Poster', aspectRatio: '16:9', resolution: '2k' }
    )
    assert.deepEqual(body, {
      model: 'image-model',
      prompt: 'Poster',
      n: 1,
      response_format: 'b64_json',
      aspect_ratio: '16:9',
      resolution: '2k'
    })
    assert.equal(result.base64, 'aW1hZ2U=')
  } finally {
    globalThis.fetch = originalFetch
  }
})

void test('generateImage redacts API key from upstream errors', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(
    `<html>authorization failed for ${baseConfig.apiKey}</html>`,
    { status: 401 }
  )) as typeof fetch

  try {
    await assert.rejects(
      generateImage(baseConfig, { prompt: 'test' }),
      (error: unknown) => error instanceof Error &&
        error.message.includes('401') &&
        !error.message.includes(baseConfig.apiKey)
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

void test('fetchImageProviderModels returns sorted unique model IDs without generating an image', async () => {
  const originalFetch = globalThis.fetch
  let requestUrl = ''
  let requestInit: RequestInit | undefined
  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input)
    requestInit = init
    return new Response(JSON.stringify({
      data: [
        { id: 'z-image' },
        { name: ' a-image ' },
        { model: 'z-image' },
        { model: { id: 'nested-image' } }
      ]
    }), { status: 200 })
  }) as typeof fetch

  try {
    const result = await fetchImageProviderModels({ ...baseConfig, model: '', modelsPath: '/v1/models' })
    assert.equal(result.success, true)
    assert.deepEqual(result.models, ['a-image', 'nested-image', 'z-image'])
    assert.equal(requestUrl, 'https://image.example.test/v1/models')
    assert.equal(requestInit?.method, 'GET')
    assert.equal(new Headers(requestInit?.headers).get('Authorization'), 'Bearer top-secret-key')
    assert.equal(requestUrl.includes('/images/generations'), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

void test('fetchImageProviderModels omits empty Authorization headers', async () => {
  const originalFetch = globalThis.fetch
  let requestInit: RequestInit | undefined
  globalThis.fetch = (async (_input, init) => {
    requestInit = init
    return new Response(JSON.stringify(['public-image-model']), { status: 200 })
  }) as typeof fetch

  try {
    const result = await fetchImageProviderModels({ ...baseConfig, apiKey: '', model: '' })
    assert.equal(result.success, true)
    assert.equal(new Headers(requestInit?.headers).has('Authorization'), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

void test('fetchImageProviderModels reports safe errors for invalid upstream responses', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(
    `denied ${baseConfig.apiKey}`,
    { status: 401 }
  )) as typeof fetch

  try {
    const denied = await fetchImageProviderModels(baseConfig)
    assert.equal(denied.success, false)
    assert.match(denied.error ?? '', /401/)
    assert.equal(denied.error?.includes(baseConfig.apiKey), false)
  } finally {
    globalThis.fetch = originalFetch
  }

  const invalidJsonFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response('not-json', { status: 200 })) as typeof fetch
  try {
    const invalid = await fetchImageProviderModels(baseConfig)
    assert.equal(invalid.success, false)
    assert.match(invalid.error ?? '', /invalid model-list JSON/)
  } finally {
    globalThis.fetch = invalidJsonFetch
  }
})

void test('fetchImageProviderModels rejects empty or unsafe URLs before requesting', async () => {
  const originalFetch = globalThis.fetch
  let requested = false
  globalThis.fetch = (async () => {
    requested = true
    return new Response('{}', { status: 200 })
  }) as typeof fetch

  try {
    const empty = await fetchImageProviderModels({ ...baseConfig, baseUrl: '' })
    const unsafe = await fetchImageProviderModels({ ...baseConfig, baseUrl: 'file:///tmp/images' })
    const credentials = await fetchImageProviderModels({ ...baseConfig, baseUrl: 'https://user:pass@example.test/v1' })
    assert.equal(empty.success, false)
    assert.equal(unsafe.success, false)
    assert.equal(credentials.success, false)
    assert.equal(requested, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

void test('testImageProvider uses model listing and never generates an image', async () => {
  const originalFetch = globalThis.fetch
  const requested: string[] = []
  globalThis.fetch = (async (input) => {
    requested.push(String(input))
    return new Response(JSON.stringify({ data: [{ id: 'image-model' }] }), { status: 200 })
  }) as typeof fetch

  try {
    const result = await testImageProvider(baseConfig)
    assert.equal(result.success, true)
    assert.deepEqual(requested, ['https://image.example.test/v1/models'])
    assert.equal(requested.some((url) => url.includes('/images/generations')), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

void test('image response parsers support known payload shapes', () => {
  assert.deepEqual(parseFirstImage({ data: [{ url: 'https://example.test/a.png' }] }), {
    url: 'https://example.test/a.png',
    base64: undefined,
    mediaType: undefined
  })
  assert.deepEqual(parseModelIds([' a ', { id: 'b' }, { name: 'c' }, { model: 'd' }, { model: { id: 'e' } }, 'a']), ['a', 'b', 'c', 'd', 'e'])
  assert.deepEqual(parseModelIds({ models: [{ name: 'grok-imagine-image' }] }), ['grok-imagine-image'])
  assert.deepEqual(parseFirstImage({ images: [{ base64: 'aW1hZ2U=', media_type: 'image/webp' }] }), {
    url: undefined,
    base64: 'aW1hZ2U=',
    mediaType: 'image/webp'
  })
  assert.deepEqual(parseFirstImage({ url: 'https://example.test/top.png' }), {
    url: 'https://example.test/top.png',
    base64: undefined,
    mediaType: undefined
  })
})
