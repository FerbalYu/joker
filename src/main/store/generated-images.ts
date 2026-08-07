import { homedir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { promises as fs } from 'node:fs'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import sharp from 'sharp'
import type { GeneratedImageRef, ImageProviderEntry } from '@shared/types'
import type { GeneratedImagePayload } from '../providers/image'
import { safeFetch } from '../tools/safe-fetch'

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_IMAGE_PIXELS = 32_000_000
const JPEG_QUALITY = 98
const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/
const MEDIA_TYPES = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp']
] as const)

export function getGeneratedImagesRoot(): string {
  return join(homedir(), '.joker', 'generated-images')
}

export async function saveGeneratedImage(
  sessionId: string,
  payload: GeneratedImagePayload,
  config: ImageProviderEntry,
  signal?: AbortSignal
): Promise<GeneratedImageRef> {
  validateId(sessionId, 'session')
  const bytes = payload.base64
    ? decodeBase64(payload.base64)
    : payload.url
      ? await downloadImage(payload.url, config, signal)
      : null
  if (!bytes) throw new Error('Image provider returned no image data')
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Generated image is too large')

  const sourceMediaType = detectMediaType(bytes, payload.mediaType)
  const outputBytes = sourceMediaType === 'image/jpeg' ? bytes : await convertToJpeg(bytes)
  if (outputBytes.length > MAX_IMAGE_BYTES) throw new Error('Generated image is too large')
  const id = crypto.randomUUID()
  const filename = `${id}.jpg`
  const mediaType = 'image/jpeg' as const
  const dir = getSessionImageDir(sessionId)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tempPath = join(dir, `.${filename}.${crypto.randomUUID()}.tmp`)
  try {
    await fs.writeFile(tempPath, outputBytes, { flag: 'wx' })
    await fs.rename(tempPath, join(dir, filename))
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
  return { id, sessionId, filename, mediaType, sizeBytes: outputBytes.length, createdAt: Date.now() }
}

export function readGeneratedImage(ref: GeneratedImageRef): Buffer {
  const path = resolveRefPath(ref)
  if (!existsSync(path)) throw new Error('Generated image file was not found')
  const bytes = readFileSync(path)
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Generated image is too large')
  if (detectMediaType(bytes, ref.mediaType) !== ref.mediaType) throw new Error('Generated image format does not match')
  return bytes
}

export function getGeneratedImagePath(ref: GeneratedImageRef): string {
  const path = resolveRefPath(ref)
  if (!existsSync(path)) throw new Error('Generated image file was not found')
  return path
}

export function cleanupGeneratedImages(sessionId: string): void {
  validateId(sessionId, 'session')
  const dir = getSessionImageDir(sessionId)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
}

export function isGeneratedImageRef(value: unknown): value is GeneratedImageRef {
  if (!value || typeof value !== 'object') return false
  const ref = value as Partial<GeneratedImageRef>
  return typeof ref.id === 'string' && ID_PATTERN.test(ref.id) &&
    typeof ref.sessionId === 'string' && ID_PATTERN.test(ref.sessionId) &&
    typeof ref.filename === 'string' && basename(ref.filename) === ref.filename &&
    (ref.mediaType === 'image/png' || ref.mediaType === 'image/jpeg' || ref.mediaType === 'image/webp') &&
    typeof ref.sizeBytes === 'number' && Number.isSafeInteger(ref.sizeBytes) && ref.sizeBytes > 0 && ref.sizeBytes <= MAX_IMAGE_BYTES &&
    typeof ref.createdAt === 'number'
}

function getSessionImageDir(sessionId: string): string {
  validateId(sessionId, 'session')
  return join(getGeneratedImagesRoot(), sessionId)
}

function resolveRefPath(ref: GeneratedImageRef): string {
  if (!isGeneratedImageRef(ref)) throw new Error('Invalid generated image reference')
  const expectedExtension = MEDIA_TYPES.get(ref.mediaType)
  if (extname(ref.filename).toLowerCase() !== expectedExtension) throw new Error('Invalid generated image filename')
  const root = resolve(getGeneratedImagesRoot())
  const path = resolve(root, ref.sessionId, ref.filename)
  if (!path.startsWith(`${root}\\`) && !path.startsWith(`${root}/`)) throw new Error('Invalid generated image path')
  return path
}

function validateId(value: string, label: string): void {
  if (!ID_PATTERN.test(value)) throw new Error(`Invalid ${label} id`)
}

function decodeBase64(value: string): Buffer {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(value.trim())
  const raw = match?.[2] ?? value
  if (raw.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 16) throw new Error('Generated image is too large')
  const bytes = Buffer.from(raw, 'base64')
  const normalizedInput = raw.replace(/\s+/g, '').replace(/=+$/, '')
  const normalizedOutput = bytes.toString('base64').replace(/=+$/, '')
  if (normalizedInput !== normalizedOutput) throw new Error('Generated image data is invalid')
  if (bytes.length === 0) throw new Error('Generated image data is empty')
  return bytes
}

async function downloadImage(url: string, config: ImageProviderEntry, signal?: AbortSignal): Promise<Buffer> {
  const target = resolveDownloadUrl(url, config.baseUrl)
  const providerOrigin = new URL(config.baseUrl).origin
  let current = new URL(target)
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const controller = new AbortController()
    const abort = (): void => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort(signal.reason)
    const timer = setTimeout(() => controller.abort(), 60_000)
    try {
      const headers: Record<string, string> = {}
      const currentUrl = new URL(current)
      if (currentUrl.origin === providerOrigin && /^\/v1\/(?:images|media)\//.test(currentUrl.pathname)) {
        headers.Authorization = `Bearer ${config.apiKey}`
      }
      const response = await safeFetch(current, { headers, signal: controller.signal, redirect: 'manual' }, { maxRedirects: 0 })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location) throw new Error('Image download redirect is missing a location')
        current = new URL(location, current)
        continue
      }
      if (!response.ok) throw new Error(`Image download failed (${response.status})`)
      const declared = Number(response.headers.get('content-length') ?? 0)
      if (declared > MAX_IMAGE_BYTES) throw new Error('Generated image is too large')
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Generated image is too large')
      return bytes
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }
  throw new Error('Too many image download redirects')
}

function resolveDownloadUrl(value: string, baseUrl: string): string {
  const url = new URL(value, `${baseUrl}/`)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Unsupported image URL')
  return url.toString()
}

async function convertToJpeg(bytes: Buffer): Promise<Buffer> {
  try {
    return await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS })
      .rotate()
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/pixel limit|input image exceeds/i.test(message)) throw new Error('Generated image has too many pixels')
    throw new Error(`Generated image could not be converted to JPEG: ${message}`)
  }
}

function detectMediaType(bytes: Buffer, declared?: string): GeneratedImageRef['mediaType'] {
  let detected: GeneratedImageRef['mediaType'] | null = null
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) detected = 'image/png'
  else if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) detected = 'image/jpeg'
  else if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') detected = 'image/webp'
  if (!detected) throw new Error('Generated content is not a supported image')
  if (declared && MEDIA_TYPES.has(declared as GeneratedImageRef['mediaType']) && declared !== detected) throw new Error('Generated image MIME type does not match its content')
  return detected
}
