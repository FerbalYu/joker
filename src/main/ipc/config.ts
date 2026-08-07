import { ipcMain } from 'electron'
import { loadConfig, normalizeConfig, preserveSkillConfigState, saveConfig, type AppConfig } from '../store/config'
import { fetchProviderModels, mergeFetchedModels, testProviderModel } from '../providers'
import { maskHeaders, restoreHeaders } from './mcp-config'
import type { FetchModelsResult, ProviderEntry, ProviderTestResult } from '@shared/types'

export function registerConfigIpc(): void {
  ipcMain.handle('config:get', () => maskConfig(loadConfig()))

  ipcMain.handle('config:save', (_event, config: AppConfig) => {
    const existing = loadConfig()
    const incoming = normalizeConfig(config)
    const existingById = new Map(existing.providers.map((provider) => [provider.id, provider]))
    const providers = incoming.providers.map((provider) => {
      const previous = existingById.get(provider.id)
      const apiKey = provider.apiKey?.includes('••') ? previous?.apiKey ?? '' : provider.apiKey ?? ''
      return { ...provider, apiKey }
    })
    const mcpServers = (incoming.mcpServers ?? []).map((server) => {
      const previous = existing.mcpServers?.find((candidate) => candidate.id === server.id)
      return { ...server, headers: restoreHeaders(server.headers, previous?.headers) }
    })
    saveConfig(preserveSkillConfigState({ ...incoming, providers, mcpServers }, existing))
    return true
  })

  ipcMain.handle('config:fetch-models', async (_event, draft: ProviderEntry): Promise<FetchModelsResult> => {
    try {
      const provider = restoreApiKey(draft)
      const result = await fetchProviderModels(provider)
      return { success: true, models: mergeFetchedModels(draft.models, result.models), latencyMs: result.latencyMs }
    } catch (error) {
      return { success: false, models: [], error: error instanceof Error ? error.message : '无法获取模型列表' }
    }
  })

  ipcMain.handle(
    'config:test-provider',
    async (_event, input: { provider: ProviderEntry; modelId?: string }): Promise<ProviderTestResult> => {
      const provider = restoreApiKey(input.provider)
      const modelId = input.modelId ?? provider.currentModelId
      return testProviderModel(provider, modelId)
    }
  )
}

function restoreApiKey(provider: ProviderEntry): ProviderEntry {
  if (!provider.apiKey?.includes('••')) return provider
  const saved = loadConfig().providers.find((candidate) => candidate.id === provider.id)
  return { ...provider, apiKey: saved?.apiKey ?? '' }
}

function maskConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    providers: config.providers.map((provider) => ({
      ...provider,
      apiKey: provider.apiKey ? maskKey(provider.apiKey) : ''
    })),
    mcpServers: config.mcpServers?.map((server) => ({ ...server, headers: maskHeaders(server.headers) }))
  }
}

function maskKey(key: string): string {
  if (key.length <= 8) return '••••'
  return key.slice(0, 4) + '••••' + key.slice(-4)
}
