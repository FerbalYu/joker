import { ipcMain, shell } from 'electron'
import type { GeneratedImageReadResult, GeneratedImageRef } from '@shared/types'
import { getGeneratedImagePath, isGeneratedImageRef, readGeneratedImage } from '../store/generated-images'

export function registerGeneratedImageIpc(): void {
  ipcMain.handle('generated-image:read', (_event, value: unknown): GeneratedImageReadResult => {
    try {
      if (!isGeneratedImageRef(value)) throw new Error('Invalid generated image reference')
      const ref = value as GeneratedImageRef
      const bytes = readGeneratedImage(ref)
      return { success: true, data: bytes.toString('base64'), mediaType: ref.mediaType }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unable to read generated image' }
    }
  })

  ipcMain.handle('generated-image:reveal', async (_event, value: unknown): Promise<{ success: boolean; error?: string }> => {
    try {
      if (!isGeneratedImageRef(value)) throw new Error('Invalid generated image reference')
      shell.showItemInFolder(getGeneratedImagePath(value as GeneratedImageRef))
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unable to reveal generated image' }
    }
  })
}
