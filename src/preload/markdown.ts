import { contextBridge, ipcRenderer } from 'electron'

const initial = { current: null as { title: string; path: string; content: string } | null }
ipcRenderer.on('markdown:init', (_event, payload: unknown) => {
  if (!payload || typeof payload !== 'object') return
  const value = payload as Partial<NonNullable<typeof initial.current>>
  if (typeof value.title !== 'string' || typeof value.path !== 'string' || typeof value.content !== 'string') return
  initial.current = { title: value.title, path: value.path, content: value.content }
  window.dispatchEvent(new Event('joker-markdown-ready'))
})

contextBridge.exposeInMainWorld('jokerMarkdown', {
  getInitial: (): { title: string; path: string; content: string } | null => initial.current
})
