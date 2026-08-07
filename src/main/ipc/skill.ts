import { ipcMain } from 'electron'
import { skillRegistry } from '../skills/registry'
import type { SkillActionResult } from '../../shared/types'

function changeSkill(id: string, enabled: boolean): SkillActionResult {
  try {
    return { success: true, skill: skillRegistry.setEnabled(id, enabled) }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function registerSkillIpc(): void {
  ipcMain.handle('skill:list', () => skillRegistry.list())
  ipcMain.handle('skill:enable', (_event, id: string): SkillActionResult => changeSkill(id, true))
  ipcMain.handle('skill:disable', (_event, id: string): SkillActionResult => changeSkill(id, false))
  // Legacy channels remain aliases so older renderers cannot create split state.
  ipcMain.handle('skill:trust', (_event, id: string): SkillActionResult => changeSkill(id, true))
  ipcMain.handle('skill:revoke-trust', (_event, id: string): SkillActionResult => changeSkill(id, false))
  ipcMain.handle('skill:reload', () => skillRegistry.list())
}
