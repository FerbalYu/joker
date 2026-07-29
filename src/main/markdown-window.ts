import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'

let markdownWindow: BrowserWindow | null = null
let currentPayload: { title: string; path: string; content: string } | null = null

export function openMarkdownWindow(payload: { title: string; path: string; content: string }, parent?: BrowserWindow): void {
  currentPayload = payload
  if (markdownWindow && !markdownWindow.isDestroyed()) {
    markdownWindow.setTitle(payload.title)
    markdownWindow.focus()
    sendPayload()
    return
  }

  markdownWindow = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 640,
    minHeight: 480,
    show: false,
    parent,
    title: payload.title,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/markdown.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  const window = markdownWindow

  window.on('ready-to-show', () => {
    if (!window.isDestroyed()) window.show()
  })
  window.on('closed', () => {
    if (markdownWindow === window) markdownWindow = null
    currentPayload = null
  })
  window.webContents.once('did-finish-load', sendPayload)
  window.webContents.setWindowOpenHandler((details) => {
    try {
      const url = new URL(details.url)
      if (url.protocol === 'http:' || url.protocol === 'https:') void shell.openExternal(url.toString())
    } catch {
      // Ignore invalid or unsafe external links.
    }
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/markdown.html`)
  } else {
    void window.loadFile(join(__dirname, '../renderer/markdown.html'))
  }
}

function sendPayload(): void {
  if (!markdownWindow || markdownWindow.isDestroyed() || !currentPayload) return
  markdownWindow.webContents.send('markdown:init', currentPayload)
}

export function closeMarkdownWindow(): void {
  if (markdownWindow && !markdownWindow.isDestroyed()) markdownWindow.close()
  markdownWindow = null
  currentPayload = null
}

