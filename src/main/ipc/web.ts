import { ipcMain } from 'electron'
import { previewWebPage } from '../tools/web'

export function registerWebIpc(): void {
  ipcMain.handle('web:preview', async (_event, url: unknown) => {
    if (typeof url !== 'string' || url.length > 2048) {
      return { url: typeof url === 'string' ? url : '', source: 'none', error: 'Invalid URL' }
    }
    return previewWebPage(url)
  })
}
