import type { ImageFetchModelsResult, ImageProviderEntry, ImageProviderTestResult } from '@shared/types'

export interface GeneratedImagePayload {
  url?: string
  base64?: string
  mediaType?: string
}

const MAX_MODEL_JSON_BYTES = 2 * 1024 * 1024
const MAX_IMAGE_JSON_BYTES = 28 * 1024 * 1024
const MAX_PROMPT_LENGTH = 8_000
const REQUEST_TIMEOUT_MS = 120_000

export async function generateImage(
  config: ImageProviderEntry,
  input: { prompt: string; size?: string; aspectRatio?: string; resolution?: string },
  signal?: AbortSignal
): Promise<GeneratedImagePayload> {
  if (!config.enabled) throw new Error('Image provider is disabled')
  if (!config.apiKey || !config.model || !config.baseUrl) throw new Error('Image provider is not configured')
  const prompt = input.prompt.trim()
  if (!prompt) throw new Error('Image prompt is required')
  if (prompt.length > MAX_PROMPT_LENGTH) throw new Error('Image prompt is too long')

  const body: Record<string, unknown> = {
    model: config.model,
    prompt,
    n: 1,
    response_format: config.responseFormat
  }
  if (config.protocol === 'grok-images') {
    body.aspect_ratio = normalizeAspectRatio(input.aspectRatio ?? config.defaultAspectRatio)
    body.resolution = normalizeResolution(input.resolution ?? config.defaultResolution)
  } else {
    body.size = normalizeSize(input.size ?? config.defaultSize)
  }

  const response = await fetchWithTimeout(`${config.baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    signal
  }, REQUEST_TIMEOUT_MS)
  const text = await readLimitedText(response, MAX_IMAGE_JSON_BYTES)
  if (!response.ok) throw new Error(`Image provider request failed (${response.status}): ${safeError(text, config.apiKey)}`)

  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error('Image provider returned invalid JSON')
  }
  const item = parseFirstImage(payload)
  if (!item.url && !item.base64) throw new Error('Image provider returned no image')
  return item
}

export async function fetchImageProviderModels(config: ImageProviderEntry): Promise<ImageFetchModelsResult> {
  const startedAt = Date.now()
  const apiKey = config.apiKey.trim()
  try {
    const url = buildModelsUrl(config)
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined
    const response = await fetchWithTimeout(url, { method: 'GET', headers }, 15_000)
    const text = await readLimitedText(response, MAX_MODEL_JSON_BYTES)
    if (!response.ok) throw new Error(`Model list request failed (${response.status}): ${safeError(text, apiKey)}`)

    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      throw new Error('Image provider returned invalid model-list JSON')
    }

    const models = parseModelIds(payload)
    if (models.length === 0) throw new Error('Image provider returned no models')
    return { success: true, models, latencyMs: Date.now() - startedAt }
  } catch (error) {
    return {
      success: false,
      models: [],
      latencyMs: Date.now() - startedAt,
      error: sanitizeMessage(error instanceof Error ? error.message : String(error), apiKey)
    }
  }
}

export async function testImageProvider(config: ImageProviderEntry): Promise<ImageProviderTestResult> {
  if (!config.baseUrl.trim() || !config.model.trim()) {
    return { success: false, status: 'unconfigured', modelId: config.model, message: 'Image provider is not configured' }
  }

  const result = await fetchImageProviderModels(config)
  if (!result.success) {
    return {
      success: false,
      status: 'unavailable',
      modelId: config.model,
      latencyMs: result.latencyMs,
      message: result.error ?? 'Unable to fetch image models'
    }
  }

  const found = result.models.includes(config.model)
  return {
    success: found,
    status: found ? 'available' : 'unavailable',
    modelId: config.model,
    latencyMs: result.latencyMs,
    message: found ? 'Model found; no paid image generation was performed' : 'Configured image model was not found'
  }
}

export function parseFirstImage(payload: unknown): GeneratedImagePayload {
  if (!payload || typeof payload !== 'object') return {}
  const root = payload as Record<string, unknown>
  const list = Array.isArray(root.data)
    ? root.data
    : Array.isArray(root.images)
      ? root.images
      : null
  const raw = list?.[0] ?? root
  if (!raw || typeof raw !== 'object') return {}
  const item = raw as Record<string, unknown>
  const base64 = item.b64_json ?? item.base64
  return {
    url: typeof item.url === 'string' ? item.url : undefined,
    base64: typeof base64 === 'string' ? base64 : undefined,
    mediaType: typeof item.mime_type === 'string'
      ? item.mime_type
      : typeof item.media_type === 'string'
        ? item.media_type
        : undefined
  }
}

export function parseModelIds(payload: unknown): string[] {
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : payload && typeof payload === 'object' && Array.isArray((payload as { models?: unknown }).models)
        ? (payload as { models: unknown[] }).models
        : []
  const ids = new Set<string>()
  for (const item of list) {
    if (typeof item === 'string') {
      if (item.trim()) ids.add(item.trim())
      continue
    }
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const direct = String(row.id ?? row.name ?? (typeof row.model === 'string' ? row.model : '')).trim()
    if (direct) {
      ids.add(direct)
      continue
    }
    if (row.model && typeof row.model === 'object') {
      const nested = row.model as Record<string, unknown>
      const nestedId = String(nested.id ?? nested.name ?? '').trim()
      if (nestedId) ids.add(nestedId)
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b))
}

function buildModelsUrl(config: ImageProviderEntry): string {
  if (!config.baseUrl.trim()) throw new Error('Image provider base URL is required')
  const base = config.baseUrl.trim().replace(/\/+$/, '')
  const url = new URL(base)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Image provider URL must use HTTP or HTTPS')
  if (url.username || url.password) throw new Error('Image provider URL cannot contain credentials')

  const path = config.modelsPath.trim() || '/models'
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  const safePath = base.endsWith('/v1') && normalizedPath.startsWith('/v1/')
    ? normalizedPath.slice(3)
    : normalizedPath
  return `${base}${safePath}`
}

function normalizeSize(value: string): string {
  return /^\d{2,5}x\d{2,5}$/.test(value) ? value : '1024x1024'
}

function normalizeAspectRatio(value: string): string {
  return /^\d{1,3}:\d{1,3}$/.test(value) ? value : '1:1'
}

function normalizeResolution(value: string): string {
  return /^(1k|2k|4k)$/i.test(value) ? value.toLowerCase() : '1k'
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const external = init.signal
  const abort = (): void => controller.abort()
  external?.addEventListener('abort', abort, { once: true })
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: 'manual' })
  } finally {
    clearTimeout(timer)
    external?.removeEventListener('abort', abort)
  }
}

async function readLimitedText(response: Response, limit: number): Promise<string> {
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > limit) throw new Error('Image provider response is too large')
  return text
}

function safeError(value: string, apiKey = ''): string {
  const trimmed = sanitizeMessage(value, apiKey).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  return trimmed.slice(0, 300) || 'Unknown upstream error'
}

function sanitizeMessage(message: string, apiKey: string): string {
  return apiKey ? message.replaceAll(apiKey, '[redacted]') : message
}
