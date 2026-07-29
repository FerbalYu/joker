import { BrowserWindow, ipcMain } from 'electron'
import { readMarkdownFile } from './file'
import { openMarkdownWindow } from '../markdown-window'

export function registerMarkdownIpc(): void {
  ipcMain.handle('markdown:open-file', async (event, value: unknown) => {
    if (typeof value !== 'string' || value.length > 4096) return { success: false, error: 'Invalid file URL' }
    const result = await readMarkdownFile(value)
    if (!result.success || !result.content || !result.path || !result.title) return result
    const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined
    openMarkdownWindow({ title: result.title, path: result.path, content: result.content }, parent)
    return { success: true }
  })
}
