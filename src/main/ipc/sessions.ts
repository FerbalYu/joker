import { ipcMain } from 'electron'
import {
  createSession,
  getSession,
  listSessions,
  appendMessage,
  replaceMessages,
  deleteSession,
  renameSession,
  setSessionProject
} from '../store/sessions'

export function registerSessionIpc(): void {
  ipcMain.handle('session:create', (_event, title?: string) => {
    return createSession(title)
  })

  ipcMain.handle('session:get', (_event, id: string) => {
    return getSession(id)
  })

  ipcMain.handle('session:list', () => {
    return listSessions()
  })

  ipcMain.handle('session:append', (_event, sessionId: string, message: unknown) => {
    return appendMessage(sessionId, message as Parameters<typeof appendMessage>[1])
  })

  ipcMain.handle('session:replace-messages', (_event, sessionId: string, messages: unknown) => {
    return replaceMessages(sessionId, messages as Parameters<typeof replaceMessages>[1])
  })

  ipcMain.handle('session:delete', (_event, id: string) => {
    return deleteSession(id)
  })

  ipcMain.handle('session:rename', (_event, id: string, title: string) => {
    return renameSession(id, title)
  })

  ipcMain.handle('session:set-project', (_event, sessionId: unknown, projectId: unknown) => {
    if (typeof sessionId !== 'string' || (projectId !== null && typeof projectId !== 'string')) return false
    return setSessionProject(sessionId, projectId as string | null)
  })
}
