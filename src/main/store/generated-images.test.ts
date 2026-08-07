import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import type { ImageProviderEntry } from '@shared/types'
import {
  cleanupGeneratedImages,
  getGeneratedImagePath,
  getGeneratedImagesRoot,
  isGeneratedImageRef,
  readGeneratedImage,
  saveGeneratedImage
} from './generated-images'

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVR4nGP4z8DAAMJgAsQAACnoA/2tJ5gCAAAAAElFTkSuQmCC'
const TRANSPARENT_PNG_BASE64 = PNG_BASE64
const WEBP_BASE64 = 'UklGRjgAAABXRUJQVlA4ICwAAADwAQCdASoCAAIAAUAmJaACdLoB+AAETAAA/vSIh/5Z8/hs49/996A3gYAAAA=='
const JPEG_BASE64 = '/9j/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABv/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AIKAIx9//9k='

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

void test('saveGeneratedImage converts PNG to a lightweight JPEG reference', async () => {
  const sessionId = `test-image-${crypto.randomUUID()}`
  try {
    const ref = await saveGeneratedImage(sessionId, {
      base64: PNG_BASE64,
      mediaType: 'image/png'
    }, config)

    const bytes = readGeneratedImage(ref)
    assert.equal(isGeneratedImageRef(ref), true)
    assert.equal(ref.sessionId, sessionId)
    assert.match(ref.filename, /^[A-Za-z0-9-]+\.jpg$/)
    assert.equal(ref.mediaType, 'image/jpeg')
    assert.equal(ref.sizeBytes, bytes.length)
    assert.equal(bytes[0], 0xff)
    assert.equal(bytes[1], 0xd8)
    assert.equal(bytes[2], 0xff)
    assert.equal('base64' in ref, false)
    assert.equal('apiKey' in ref, false)
    assert.equal('path' in ref, false)
    assert.equal(getGeneratedImagePath(ref).startsWith(getGeneratedImagesRoot()), true)
  } finally {
    cleanupGeneratedImages(sessionId)
  }
})

void test('saveGeneratedImage accepts base64 data URLs and stores JPEG', async () => {
  const sessionId = `test-image-${crypto.randomUUID()}`
  try {
    const ref = await saveGeneratedImage(sessionId, {
      base64: `data:image/png;base64,${PNG_BASE64}`,
      mediaType: 'image/png'
    }, config)
    assert.equal(ref.mediaType, 'image/jpeg')
    assert.match(ref.filename, /\.jpg$/)
  } finally {
    cleanupGeneratedImages(sessionId)
  }
})

void test('saveGeneratedImage converts WebP and flattens transparent PNG onto white', async () => {
  const webpSession = `test-image-${crypto.randomUUID()}`
  const transparentSession = `test-image-${crypto.randomUUID()}`
  try {
    const webpRef = await saveGeneratedImage(webpSession, { base64: WEBP_BASE64, mediaType: 'image/webp' }, config)
    assert.equal(webpRef.mediaType, 'image/jpeg')
    assert.match(webpRef.filename, /\.jpg$/)

    const transparentRef = await saveGeneratedImage(transparentSession, { base64: TRANSPARENT_PNG_BASE64, mediaType: 'image/png' }, config)
    const pixel = await sharp(readGeneratedImage(transparentRef)).raw().toBuffer()
    assert.ok(pixel[0] >= 245)
    assert.ok(pixel[1] >= 245)
    assert.ok(pixel[2] >= 245)
  } finally {
    cleanupGeneratedImages(webpSession)
    cleanupGeneratedImages(transparentSession)
  }
})

void test('saveGeneratedImage keeps existing JPEG bytes without recompression', async () => {
  const sessionId = `test-image-${crypto.randomUUID()}`
  try {
    const source = Buffer.from(JPEG_BASE64, 'base64')
    const ref = await saveGeneratedImage(sessionId, { base64: JPEG_BASE64, mediaType: 'image/jpeg' }, config)
    assert.equal(ref.mediaType, 'image/jpeg')
    assert.equal(readGeneratedImage(ref).equals(source), true)
  } finally {
    cleanupGeneratedImages(sessionId)
  }
})

void test('historical PNG references remain readable', () => {
  const sessionId = `test-image-${crypto.randomUUID()}`
  const id = crypto.randomUUID()
  const filename = `${id}.png`
  const dir = join(getGeneratedImagesRoot(), sessionId)
  const legacyRef = {
    id,
    sessionId,
    filename,
    mediaType: 'image/png' as const,
    sizeBytes: Buffer.from(PNG_BASE64, 'base64').length,
    createdAt: Date.now()
  }
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, filename), Buffer.from(PNG_BASE64, 'base64'), { flag: 'wx', flush: true })
    assert.equal(readGeneratedImage(legacyRef).equals(Buffer.from(PNG_BASE64, 'base64')), true)
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
