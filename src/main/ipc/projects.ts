import { dialog, ipcMain } from 'electron'
import {
  addProject,
  loadProjectState,
  resolveProjectPath,
  selectProject
} from '../store/projects'
import type { ProjectState, GitStatus } from '../../shared/types'
import { detectGitStatus } from '../git/status'

function result(state: ProjectState): { success: true; state: ProjectState } {
  return { success: true, state }
}

export function registerProjectIpc(): void {
  ipcMain.handle('project:get', () => result(loadProjectState()))

  ipcMain.handle('project:pick', async () => {
    const selected = await dialog.showOpenDialog({
      title: '选择工作文件夹',
      properties: ['openDirectory', 'createDirectory']
    })
    if (selected.canceled || selected.filePaths.length === 0) {
      return { success: false, canceled: true }
    }
    try {
      return result(addProject(selected.filePaths[0]))
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : '无法加入工作文件夹' }
    }
  })

  ipcMain.handle('project:select', (_event, projectId: unknown) => {
    if (typeof projectId !== 'string') return { success: false, error: 'Invalid project' }
    try {
      return result(selectProject(projectId))
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : '无法切换项目' }
    }
  })

  ipcMain.handle('project:git-status', async (_event, projectId: unknown) => {
    if (typeof projectId !== 'string') return { success: false, error: 'Invalid project' }
    const workspacePath = resolveProjectPath(projectId)
    if (!workspacePath) return { success: false, error: 'Project folder is no longer available' }
    const status: GitStatus = await detectGitStatus(workspacePath)
    return { success: true, status }
  })

  // Keep this validation path available to chat IPC callers without exposing filesystem paths to the renderer.
  ipcMain.handle('project:resolve', (_event, projectId: unknown) => {
    if (typeof projectId !== 'string') return null
    return resolveProjectPath(projectId)
  })
}
