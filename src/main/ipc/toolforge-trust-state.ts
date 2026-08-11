import type { AppConfig, ProjectState, ToolForgeFullTrustResult, ToolForgeFullTrustState } from '../../shared/types'
import { hasToolForgeFullTrust, setToolForgeFullTrust } from '../store/config'

export interface ToolForgeTrustDependencies {
  loadConfig: () => AppConfig
  saveConfig: (config: AppConfig) => void
  loadProjectState: () => ProjectState
  resolveProjectPath: (projectId: string) => string | null
}

export function getSelectedWorkspaceFullTrustState(dependencies: ToolForgeTrustDependencies): ToolForgeFullTrustResult {
  const projects = dependencies.loadProjectState()
  const projectId = projects.activeProjectId
  const project = projectId ? projects.projects.find((candidate) => candidate.id === projectId) : undefined
  if (!project) return { success: false, error: 'No working folder is selected' }

  const workspacePath = dependencies.resolveProjectPath(project.id)
  if (!workspacePath) return { success: false, error: 'Working folder is no longer available' }

  const state: ToolForgeFullTrustState = {
    projectId: project.id,
    projectName: project.name,
    workspacePath,
    granted: hasToolForgeFullTrust(dependencies.loadConfig(), workspacePath)
  }
  return { success: true, data: state }
}

export function updateSelectedWorkspaceFullTrust(
  granted: boolean,
  dependencies: ToolForgeTrustDependencies
): ToolForgeFullTrustResult {
  const current = getSelectedWorkspaceFullTrustState(dependencies)
  if (!current.success || !current.data) return current
  try {
    dependencies.saveConfig(setToolForgeFullTrust(dependencies.loadConfig(), current.data.workspacePath, granted))
    return { success: true, data: { ...current.data, granted } }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unable to update ToolForge full trust' }
  }
}
