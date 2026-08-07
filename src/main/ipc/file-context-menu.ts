import type { Stats } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { fileUrlToLocalPath } from './file-path'

export const MAX_CLIPBOARD_FILE_BYTES = 2 * 1024 * 1024

export type FileContextAction = 'open' | 'reveal' | 'open-with' | 'copy-path' | 'copy-contents'
export type FileContextLanguage = 'zh' | 'en'

export interface FileContextTarget {
  path: string
  size: number
}

export type FileContextMenuEntry =
  | { type: 'separator' }
  | { type: 'action'; action: FileContextAction; label: string; enabled: boolean }

export interface FileContextActionResult {
  success: boolean
  action?: FileContextAction
  path?: string
  error?: string
}

export interface FileContextRuntime {
  platform: NodeJS.Platform
  statFile: (path: string) => Promise<Pick<Stats, 'isFile' | 'size'>>
  readFileBytes: (path: string) => Promise<Uint8Array>
  openPath: (path: string) => Promise<string>
  revealPath: (path: string) => void
  writeClipboardText: (value: string) => void
  openWith?: (path: string) => Promise<void>
}

const defaultFileRuntime = {
  statFile: stat,
  readFileBytes: readFile
}

export async function resolveFileContextTarget(
  value: string,
  statFile: FileContextRuntime['statFile'] = defaultFileRuntime.statFile
): Promise<FileContextTarget> {
  let filePath: string
  try {
    filePath = fileUrlToLocalPath(value)
  } catch {
    throw new Error('Invalid file URL')
  }

  let info: Pick<Stats, 'isFile' | 'size'>
  try {
    info = await statFile(filePath)
  } catch (error) {
    if (isMissingFileError(error)) throw new Error('File not found')
    throw error
  }
  if (!info.isFile()) throw new Error('The target is not a file')
  return { path: filePath, size: info.size }
}

export function buildFileContextMenuEntries(
  language: FileContextLanguage,
  target: FileContextTarget,
  platform: NodeJS.Platform
): FileContextMenuEntry[] {
  const labels = language === 'zh'
    ? {
        open: '打开文件',
        reveal: '在文件资源管理器中显示',
        openWith: '打开方式…',
        copyPath: '复制绝对路径',
        copyContents: '复制文件内容'
      }
    : {
        open: 'Open file',
        reveal: 'Show in File Explorer',
        openWith: 'Open with…',
        copyPath: 'Copy absolute path',
        copyContents: 'Copy file contents'
      }

  return [
    { type: 'action', action: 'open', label: labels.open, enabled: true },
    { type: 'action', action: 'reveal', label: labels.reveal, enabled: true },
    ...(platform === 'win32'
      ? [{ type: 'action', action: 'open-with', label: labels.openWith, enabled: true } as const]
      : []),
    { type: 'separator' },
    { type: 'action', action: 'copy-path', label: labels.copyPath, enabled: true },
    {
      type: 'action',
      action: 'copy-contents',
      label: target.size <= MAX_CLIPBOARD_FILE_BYTES
        ? labels.copyContents
        : language === 'zh'
          ? `${labels.copyContents}（文件超过 2 MiB）`
          : `${labels.copyContents} (file exceeds 2 MiB)`,
      enabled: target.size <= MAX_CLIPBOARD_FILE_BYTES
    }
  ]
}

export async function performFileContextAction(
  value: string,
  action: FileContextAction,
  runtime: FileContextRuntime
): Promise<FileContextActionResult> {
  try {
    const target = await resolveFileContextTarget(value, runtime.statFile)
    switch (action) {
      case 'open': {
        const error = await runtime.openPath(target.path)
        if (error) throw new Error(error)
        break
      }
      case 'reveal':
        runtime.revealPath(target.path)
        break
      case 'open-with':
        if (runtime.platform !== 'win32' || !runtime.openWith) {
          throw new Error('Open with is only supported on Windows')
        }
        await runtime.openWith(target.path)
        break
      case 'copy-path':
        runtime.writeClipboardText(target.path)
        break
      case 'copy-contents': {
        if (target.size > MAX_CLIPBOARD_FILE_BYTES) throw new Error('File is too large to copy')
        const bytes = await runtime.readFileBytes(target.path)
        let content: string
        try {
          content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        } catch {
          throw new Error('Only UTF-8 text files can be copied')
        }
        if (content.includes('\u0000')) throw new Error('Only UTF-8 text files can be copied')
        runtime.writeClipboardText(content)
        break
      }
    }
    return { success: true, action, path: target.path }
  } catch (error) {
    return {
      success: false,
      action,
      error: error instanceof Error ? error.message : 'Unable to perform file action'
    }
  }
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
