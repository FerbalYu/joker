import { spawn } from 'node:child_process'
import { BrowserWindow, clipboard, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { readMarkdownFile, revealFile, saveMarkdownFile } from './file'
import {
  buildFileContextMenuEntries,
  performFileContextAction,
  resolveFileContextTarget,
  type FileContextAction,
  type FileContextActionResult,
  type FileContextLanguage,
  type FileContextRuntime
} from './file-context-menu'

export function registerFileIpc(): void {
  ipcMain.handle('file:reveal', async (_event, value: unknown) => {
    if (typeof value !== 'string' || value.length > 4096) return { success: false, error: 'Invalid file URL' }
    return revealFile(value)
  })

  ipcMain.handle('file:read-markdown', async (_event, value: unknown) => {
    if (typeof value !== 'string' || value.length > 4096) return { success: false, error: 'Invalid file URL' }
    return readMarkdownFile(value)
  })

  ipcMain.handle('file:show-context-menu', async (event, value: unknown, language: unknown) => {
    if (typeof value !== 'string' || value.length > 4096) return { success: false, error: 'Invalid file URL' }
    const parent = BrowserWindow.fromWebContents(event.sender)
    if (!parent) return { success: false, error: 'Unable to show file menu' }
    return showFileContextMenu(parent, value, language === 'en' ? 'en' : 'zh')
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

async function showFileContextMenu(
  parent: BrowserWindow,
  value: string,
  language: FileContextLanguage
): Promise<FileContextActionResult & { canceled?: boolean }> {
  try {
    const runtime = createFileContextRuntime()
    const target = await resolveFileContextTarget(value, runtime.statFile)
    const entries = buildFileContextMenuEntries(language, target, runtime.platform)

    return await new Promise((resolve) => {
      let closed = false
      let selected: Promise<FileContextActionResult> | null = null
      let settled = false

      const settle = (): void => {
        if (!closed || settled) return
        if (!selected) {
          settled = true
          resolve({ success: true, canceled: true })
          return
        }
        settled = true
        void selected.then(resolve)
      }

      const run = (action: FileContextAction): void => {
        if (selected) return
        selected = performFileContextAction(value, action, runtime)
        settle()
      }

      const template: MenuItemConstructorOptions[] = entries.map((entry) => entry.type === 'separator'
        ? { type: 'separator' }
        : {
            label: entry.label,
            enabled: entry.enabled,
            click: () => run(entry.action)
          })
      const menu = Menu.buildFromTemplate(template)
      menu.popup({
        window: parent,
        callback: () => {
          closed = true
          settle()
        }
      })
    })
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unable to show file menu' }
  }
}

function createFileContextRuntime(): FileContextRuntime {
  return {
    platform: process.platform,
    statFile: async (path) => {
      const { stat } = await import('node:fs/promises')
      return stat(path)
    },
    readFileBytes: async (path) => {
      const { readFile } = await import('node:fs/promises')
      return readFile(path)
    },
    openPath: (path) => shell.openPath(path),
    revealPath: (path) => shell.showItemInFolder(path),
    writeClipboardText: (value) => clipboard.writeText(value),
    openWith: process.platform === 'win32' ? openWithWindows : undefined
  }
}

async function openWithWindows(path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', path], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
