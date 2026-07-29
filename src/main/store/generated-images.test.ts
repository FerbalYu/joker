import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import type { ImageProviderEntry } from '@shared/types'
import {
  cleanupGeneratedImages,
  getGeneratedImagePath,
  getGeneratedImagesRoot,
  isGeneratedImageRef,
  readGeneratedImage,
  saveGeneratedImage
} from './generated-images'

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII='

const config: ImageProviderEntry = {
  id: 'image-test',
  enabled: true,
  name: 'Images',
  protocol: 'openai-images',
  baseUrl: 'https://93.184.216.34/v1',
  apiKey: 'provider-secret',
  model: 'image-model',
  modelsPath: '/models',
  defaultSize: '1024x1024',
  defaultAspectRatio: '1:1',
  defaultResolution: '1k',
  responseFormat: 'b64_json'
}

void test('saveGeneratedImage persists a lightweight validated reference', async () => {
  const sessionId = `test-image-${crypto.randomUUID()}`
  try {
    const ref = await saveGeneratedImage(sessionId, {
      base64: PNG_BASE64,
      mediaType: 'image/png'
    }, config)

    assert.equal(isGeneratedImageRef(ref), true)
    assert.equal(ref.sessionId, sessionId)
    assert.match(ref.filename, /^[A-Za-z0-9-]+\.png$/)
    assert.equal('base64' in ref, false)
    assert.equal('apiKey' in ref, false)
    assert.equal('path' in ref, false)
    assert.equal(readGeneratedImage(ref).equals(Buffer.from(PNG_BASE64, 'base64')), true)
    assert.equal(getGeneratedImagePath(ref).startsWith(getGeneratedImagesRoot()), true)
  } finally {
    cleanupGeneratedImages(sessionId)
  }
})

void test('saveGeneratedImage accepts base64 data URLs', async () => {
  const sessionId = `test-image-${crypto.randomUUID()}`
  try {
    const ref = await saveGeneratedImage(sessionId, {
      base64: `data:image/png;base64,${PNG_BASE64}`,
      mediaType: 'image/png'
    }, config)
    assert.equal(ref.mediaType, 'image/png')
  } finally {
    cleanupGeneratedImages(sessionId)
  }
})

void test('saveGeneratedImage rejects MIME spoofing and invalid base64', async () => {
  const sessionId = `test-image-${crypto.randomUUID()}`
  try {
    await assert.rejects(
      saveGeneratedImage(sessionId, { base64: PNG_BASE64, mediaType: 'image/jpeg' }, config),
      /MIME type does not match/
    )
    await assert.rejects(
      saveGeneratedImage(sessionId, { base64: 'not-base64!', mediaType: 'image/png' }, config),
      /data is invalid/
    )
  } finally {
    cleanupGeneratedImages(sessionId)
  }
})

void test('third-party image downloads never receive provider authorization', async () => {
  const originalFetch = globalThis.fetch
  const sessionId = `test-image-${crypto.randomUUID()}`
  let authorization: string | null = 'not-called'
  globalThis.fetch = (async (_input, init) => {
    authorization = new Headers(init?.headers).get('Authorization')
    return new Response(Buffer.from(PNG_BASE64, 'base64'), {
      status: 200,
      headers: { 'Content-Type': 'image/png' }
    })
  }) as typeof fetch

  try {
    await saveGeneratedImage(sessionId, { url: 'https://93.184.216.34/image.png' }, config)
    assert.equal(authorization, null)
  } finally {
    globalThis.fetch = originalFetch
    cleanupGeneratedImages(sessionId)
  }
})

void test('provider media downloads receive authorization only on the controlled path', async () => {
  const originalFetch = globalThis.fetch
  const sessionId = `test-image-${crypto.randomUUID()}`
  let authorization: string | null = null
  globalThis.fetch = (async (_input, init) => {
    authorization = new Headers(init?.headers).get('Authorization')
    return new Response(Buffer.from(PNG_BASE64, 'base64'), { status: 200 })
  }) as typeof fetch

  try {
    await saveGeneratedImage(sessionId, { url: '/v1/images/result.png' }, config)
    assert.equal(authorization, 'Bearer provider-secret')
  } finally {
    globalThis.fetch = originalFetch
    cleanupGeneratedImages(sessionId)
  }
})

void test('cleanupGeneratedImages removes only the selected session directory', async () => {
  const first = `test-image-${crypto.randomUUID()}`
  const second = `test-image-${crypto.randomUUID()}`
  const firstRef = await saveGeneratedImage(first, { base64: PNG_BASE64 }, config)
  const secondRef = await saveGeneratedImage(second, { base64: PNG_BASE64 }, config)

  try {
    cleanupGeneratedImages(first)
    assert.equal(existsSync(getGeneratedImagePath(secondRef)), true)
    assert.throws(() => getGeneratedImagePath(firstRef), /not found/)
  } finally {
    cleanupGeneratedImages(first)
    cleanupGeneratedImages(second)
  }
})
