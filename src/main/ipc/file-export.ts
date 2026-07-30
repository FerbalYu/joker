import { writeFile } from 'node:fs/promises'

const MAX_MARKDOWN_EXPORT_BYTES = 32 * 1024 * 1024
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

export function markdownExportFilename(title: string): string {
  let value = title.normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\.md$/i, '')
    .replace(/[<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .replace(/^[ .-]+|[ .-]+$/g, '')
  if (!value || value === '.' || value === '..') value = 'research-report'
  if (WINDOWS_DEVICE_NAME.test(value)) value = `_${value}`
  value = Array.from(value).slice(0, 120).join('').replace(/[ .]+$/g, '') || 'research-report'
  return `${value}.md`
}

export function ensureMarkdownExtension(path: string): string {
  return /\.md$/i.test(path) ? path : `${path}.md`
}

export function markdownExportWithinLimit(content: string): boolean {
  return Buffer.byteLength(content, 'utf8') <= MAX_MARKDOWN_EXPORT_BYTES
}

export async function writeMarkdownExport(path: string, content: string): Promise<string> {
  if (!markdownExportWithinLimit(content)) throw new Error('Markdown export is too large')
  const targetPath = ensureMarkdownExtension(path)
  await writeFile(targetPath, content, 'utf8')
  return targetPath
}

export { MAX_MARKDOWN_EXPORT_BYTES }
