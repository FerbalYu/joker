import type { ImageProviderConfig, ImageProviderEntry } from '@shared/types'

export function restoreImageConfigApiKeys(
  incoming: ImageProviderConfig,
  existing: ImageProviderConfig
): ImageProviderConfig {
  const existingById = new Map(existing.providers.map((provider) => [provider.id, provider]))
  return {
    ...incoming,
    providers: incoming.providers.map((provider) => ({
      ...provider,
      apiKey: provider.apiKey.includes('••') ? existingById.get(provider.id)?.apiKey ?? '' : provider.apiKey
    }))
  }
}

export function restoreImageProviderApiKey(
  provider: ImageProviderEntry,
  existing: ImageProviderConfig
): ImageProviderEntry {
  if (!provider.apiKey.includes('••')) return provider
  const saved = existing.providers.find((candidate) => candidate.id === provider.id)
  return { ...provider, apiKey: saved?.apiKey ?? '' }
}

export function maskImageConfig(config: ImageProviderConfig): ImageProviderConfig {
  return {
    ...config,
    providers: config.providers.map((provider) => ({
      ...provider,
      apiKey: provider.apiKey ? maskKey(provider.apiKey) : ''
    }))
  }
}

function maskKey(key: string): string {
  if (key.length <= 8) return '••••'
  return `${key.slice(0, 4)}••••${key.slice(-4)}`
}
