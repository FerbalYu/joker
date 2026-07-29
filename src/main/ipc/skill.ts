import { ipcMain } from 'electron'
import { skillRegistry } from '../skills/registry'

export function registerSkillIpc(): void {
  ipcMain.handle('skill:list', () => skillRegistry.list())
  ipcMain.handle('skill:enable', (_event, id: string) => skillRegistry.setEnabled(id, true))
  ipcMain.handle('skill:disable', (_event, id: string) => skillRegistry.setEnabled(id, false))
  ipcMain.handle('skill:reload', () => {
    skillRegistry.reload()
    return skillRegistry.list()
  })
}
