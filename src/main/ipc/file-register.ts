import { BrowserWindow, ipcMain } from 'electron'
import { readMarkdownFile, revealFile, saveMarkdownFile } from './file'

export function registerFileIpc(): void {
  ipcMain.handle('file:reveal', async (_event, value: unknown) => {
    if (typeof value !== 'string' || value.length > 4096) return { success: false, error: 'Invalid file URL' }
    return revealFile(value)
  })

  ipcMain.handle('file:read-markdown', async (_event, value: unknown) => {
    if (typeof value !== 'string' || value.length > 4096) return { success: false, error: 'Invalid file URL' }
    return readMarkdownFile(value)
  })

  ipcMain.handle('file:save-markdown', async (event, value: unknown) => {
    if (!value || typeof value !== 'object') return { success: false, error: 'Invalid Markdown export' }
    const candidate = value as { title?: unknown; content?: unknown }
    if (typeof candidate.title !== 'string' || candidate.title.length > 500 || typeof candidate.content !== 'string') {
      return { success: false, error: 'Invalid Markdown export' }
    }
    return saveMarkdownFile(BrowserWindow.fromWebContents(event.sender), { title: candidate.title, content: candidate.content })
  })
}
