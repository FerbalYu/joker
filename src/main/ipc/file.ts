import { app, dialog, shell, type BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileUrlToLocalPath } from './file-path'
import {
  markdownExportFilename,
  markdownExportWithinLimit,
  writeMarkdownExport
} from './file-export'

const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024

export { fileUrlToLocalPath } from './file-path'
export {
  ensureMarkdownExtension,
  markdownExportFilename,
  MAX_MARKDOWN_EXPORT_BYTES
} from './file-export'

export async function revealFile(value: string): Promise<{ success: boolean; error?: string }> {
  try {
    const filePath = fileUrlToLocalPath(value)
    if (!existsSync(filePath)) return { success: false, error: 'File not found' }
    const result = await stat(filePath)
    if (!result.isFile()) return { success: false, error: 'The target is not a file' }
    shell.showItemInFolder(filePath)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unable to reveal file' }
  }
}

export async function readMarkdownFile(value: string): Promise<{ success: boolean; title?: string; path?: string; content?: string; error?: string }> {
  try {
    const filePath = fileUrlToLocalPath(value)
    const info = await stat(filePath)
    if (!info.isFile()) return { success: false, error: 'The target is not a file' }
    if (!/\.(?:md|markdown)$/i.test(filePath)) return { success: false, error: 'Only Markdown files are supported' }
    if (info.size > MAX_MARKDOWN_BYTES) return { success: false, error: 'Markdown file is too large' }
    const content = await readFile(filePath, 'utf8')
    return { success: true, title: filePath.slice(Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/')) + 1), path: filePath, content }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unable to read Markdown file' }
  }
}

export type SaveMarkdownResult = { success: boolean; canceled?: boolean; path?: string; error?: string }

export async function saveMarkdownFile(parent: BrowserWindow | null, value: { title: string; content: string }): Promise<SaveMarkdownResult> {
  if (!markdownExportWithinLimit(value.content)) return { success: false, error: 'Markdown export is too large' }
  const filename = markdownExportFilename(value.title)
  try {
    const options = {
      title: 'Save research report',
      defaultPath: join(app.getPath('downloads'), filename),
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    }
    const result = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { success: false, canceled: true }
    const path = await writeMarkdownExport(result.filePath, value.content)
    return { success: true, path }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unable to save Markdown file' }
  }
}

export { MAX_MARKDOWN_BYTES }
