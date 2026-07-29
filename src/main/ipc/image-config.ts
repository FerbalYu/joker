import { ipcMain } from 'electron'
import type { ImageFetchModelsResult, ImageProviderConfig, ImageProviderEntry, ImageProviderTestResult } from '@shared/types'
import { loadImageConfig, normalizeImageConfig, normalizeImageProvider, saveImageConfig } from '../store/image-config'
import { fetchImageProviderModels, testImageProvider } from '../providers/image'
import {
  maskImageConfig,
  restoreImageConfigApiKeys,
  restoreImageProviderApiKey
} from './image-config-helpers'

export function registerImageConfigIpc(): void {
  ipcMain.handle('image-config:get', () => maskImageConfig(loadImageConfig()))

  ipcMain.handle('image-config:save', (_event, draft: ImageProviderConfig) => {
    const existing = loadImageConfig()
    const incoming = normalizeImageConfig(draft)
    saveImageConfig(restoreImageConfigApiKeys(incoming, existing))
    return true
  })

  ipcMain.handle('image-config:fetch-models', async (_event, draft: ImageProviderEntry): Promise<ImageFetchModelsResult> => {
    if (!draft?.baseUrl?.trim()) {
      return { success: false, models: [], error: 'Image provider base URL is required' }
    }
    const provider = restoreImageProviderApiKey(normalizeImageProvider(draft), loadImageConfig())
    return fetchImageProviderModels(provider)
  })

  ipcMain.handle('image-config:test', async (_event, draft: ImageProviderEntry): Promise<ImageProviderTestResult> => {
    const provider = restoreImageProviderApiKey(normalizeImageProvider(draft), loadImageConfig())
    return testImageProvider(provider)
  })
}
