import { shell } from 'electron'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { fileUrlToLocalPath } from './file-path'

const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024

export { fileUrlToLocalPath } from './file-path'

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

export { MAX_MARKDOWN_BYTES }
