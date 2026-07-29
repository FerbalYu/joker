import { ipcMain } from 'electron'
import { readMarkdownFile, revealFile } from './file'

export function registerFileIpc(): void {
  ipcMain.handle('file:reveal', async (_event, value: unknown) => {
    if (typeof value !== 'string' || value.length > 4096) return { success: false, error: 'Invalid file URL' }
    return revealFile(value)
  })

  ipcMain.handle('file:read-markdown', async (_event, value: unknown) => {
    if (typeof value !== 'string' || value.length > 4096) return { success: false, error: 'Invalid file URL' }
    return readMarkdownFile(value)
  })
}
