import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { ImageProviderConfig, ImageProviderEntry } from '@shared/types'

const DEFAULT_PROVIDER: ImageProviderEntry = {
  id: 'image-default',
  enabled: false,
  name: 'Image provider',
  protocol: 'openai-images',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-image-1',
  modelsPath: '/models',
  defaultSize: '1024x1024',
  defaultAspectRatio: '1:1',
  defaultResolution: '1k',
  responseFormat: 'url'
}

function getDefaults(): ImageProviderConfig {
  return {
    providers: [{ ...DEFAULT_PROVIDER }],
    activeProviderId: DEFAULT_PROVIDER.id
  }
}

function getConfigDir(): string {
  return join(homedir(), '.joker')
}

export function getImageConfigPath(): string {
  return join(getConfigDir(), 'image-provider.json')
}

export function normalizeImageProvider(raw: unknown, index = 0, fallbackId?: string): ImageProviderEntry {
  const value = raw && typeof raw === 'object' ? raw as Partial<ImageProviderEntry> : {}
  const protocol = value.protocol === 'grok-images' ? 'grok-images' : 'openai-images'
  return {
    id: normalizeId(value.id, fallbackId ?? `image-provider-${index + 1}`),
    enabled: value.enabled === true,
    name: safeText(value.name, DEFAULT_PROVIDER.name, 120),
    protocol,
    baseUrl: safeText(value.baseUrl, DEFAULT_PROVIDER.baseUrl, 2048).replace(/\/+$/, ''),
    apiKey: typeof value.apiKey === 'string' ? value.apiKey.slice(0, 4096) : '',
    model: safeText(value.model, protocol === 'grok-images' ? 'grok-imagine-image' : DEFAULT_PROVIDER.model, 240),
    modelsPath: normalizePath(value.modelsPath, DEFAULT_PROVIDER.modelsPath),
    defaultSize: /^\d{2,5}x\d{2,5}$/.test(value.defaultSize ?? '') ? value.defaultSize as string : DEFAULT_PROVIDER.defaultSize,
    defaultAspectRatio: /^\d{1,3}:\d{1,3}$/.test(value.defaultAspectRatio ?? '') ? value.defaultAspectRatio as string : DEFAULT_PROVIDER.defaultAspectRatio,
    defaultResolution: /^(1k|2k|4k)$/i.test(value.defaultResolution ?? '') ? (value.defaultResolution as string).toLowerCase() : DEFAULT_PROVIDER.defaultResolution,
    responseFormat: value.responseFormat === 'b64_json' ? 'b64_json' : 'url'
  }
}

export function normalizeImageConfig(raw: unknown): ImageProviderConfig {
  if (!raw || typeof raw !== 'object') return getDefaults()
  const value = raw as Partial<ImageProviderConfig> & Partial<ImageProviderEntry>

  if (Array.isArray(value.providers)) {
    const seen = new Set<string>()
    const providers = value.providers.map((provider, index) => {
      const normalized = normalizeImageProvider(provider, index)
      let id = normalized.id
      let suffix = 2
      while (seen.has(id)) {
        id = `${normalized.id}-${suffix}`
        suffix += 1
      }
      seen.add(id)
      return id === normalized.id ? normalized : { ...normalized, id }
    })
    const safeProviders = providers.length > 0 ? providers : getDefaults().providers
    const activeProviderId = safeProviders.some((provider) => provider.id === value.activeProviderId)
      ? value.activeProviderId as string
      : safeProviders[0].id
    return { providers: safeProviders, activeProviderId }
  }

  const migrated = normalizeImageProvider(value, 0, 'image-default')
  return { providers: [migrated], activeProviderId: migrated.id }
}

export function loadImageConfig(): ImageProviderConfig {
  const path = getImageConfigPath()
  if (!existsSync(path)) return getDefaults()
  try {
    return normalizeImageConfig(JSON.parse(readFileSync(path, 'utf-8')))
  } catch {
    return getDefaults()
  }
}

export function saveImageConfig(config: ImageProviderConfig): void {
  const dir = getConfigDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(getImageConfigPath(), JSON.stringify(normalizeImageConfig(config), null, 2), 'utf-8')
}

export function resolveActiveImageProvider(config: ImageProviderConfig): ImageProviderEntry {
  const active = config.providers.find((provider) => provider.id === config.activeProviderId && provider.enabled)
  const fallback = active ?? config.providers.find((provider) => provider.enabled)
  if (!fallback) throw new Error('No enabled image provider is configured')
  return fallback
}

function normalizeId(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(value) ? value : fallback
}

function safeText(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : fallback
}

function normalizePath(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !value.trim()) return fallback
  const path = value.trim().slice(0, 240)
  return path.startsWith('/') ? path : `/${path}`
}
