import { ipcMain } from 'electron'

import type { ToolForgeFullTrustResult } from '../../shared/types'
import { loadConfig, saveConfig } from '../store/config'
import { loadProjectState, resolveProjectPath } from '../store/projects'
import { getSelectedWorkspaceFullTrustState, updateSelectedWorkspaceFullTrust, type ToolForgeTrustDependencies } from './toolforge-trust-state'

const dependencies: ToolForgeTrustDependencies = {
  loadConfig,
  saveConfig,
  loadProjectState,
  resolveProjectPath
}

export function registerToolForgeTrustIpc(): void {
  ipcMain.handle('toolforge-trust:get', (): ToolForgeFullTrustResult => getSelectedWorkspaceFullTrustState(dependencies))
  ipcMain.handle('toolforge-trust:grant', (): ToolForgeFullTrustResult => updateSelectedWorkspaceFullTrust(true, dependencies))
  ipcMain.handle('toolforge-trust:revoke', (): ToolForgeFullTrustResult => updateSelectedWorkspaceFullTrust(false, dependencies))
}
