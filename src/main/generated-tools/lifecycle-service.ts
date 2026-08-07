import { readGeneratedToolRegistry, disableGeneratedTool, promoteGeneratedTool, rollbackGeneratedTool, revalidateGeneratedTool, removeGeneratedTool } from './registry'
import { getJokerHomeDir } from '../store/paths'
import { assertToolForgeId } from './paths'
import { quarantineGeneratedToolDirectory } from './store'

export type GeneratedToolLifecycleAction = 'disable' | 'reenable' | 'rollback' | 'revalidate' | 'remove'

export interface GeneratedToolLifecycleMutationInput {
  toolId: string
  expectedRevision: number
  operationId: string
  versionId?: string
}

export interface GeneratedToolLifecycleMutationResult {
  success: boolean
  error?: string
  registryRevision?: number
  capabilityRevision?: number
  activeVersionId?: string
  quarantineId?: string
}

export function mutateGeneratedToolLifecycle(
  action: GeneratedToolLifecycleAction,
  input: GeneratedToolLifecycleMutationInput,
  jokerHome = getJokerHomeDir(),
  now = Date.now
): GeneratedToolLifecycleMutationResult {
  try {
    const toolId = assertToolForgeId(input.toolId, 'tool id')
    const registry = readGeneratedToolRegistry(jokerHome)
    const versionId = input.versionId === undefined
      ? undefined
      : assertToolForgeId(input.versionId, 'version id')

    if ((action === 'reenable' || action === 'rollback') && !versionId) {
      throw new Error(`${action === 'rollback' ? 'Rollback' : 'Re-enable'} requires a target stable version`)
    }

    let quarantineId: string | undefined
    let restore: (() => void) | undefined
    if (action === 'remove') {
      const entry = registry.entries.find((item) => item.toolId === toolId)
      if (!entry) throw new Error(`Generated Tool is not registered: ${toolId}`)
      const pointer = registry.activePointers.find((item) => item.toolId === toolId)
      if (pointer?.activeVersionId !== undefined) throw new Error('Cannot remove Generated Tool while an active version exists')
      const quarantine = quarantineGeneratedToolDirectory(`${jokerHome}/.joker/generated-tools`, toolId, input.operationId)
      quarantineId = quarantine.quarantineId
      restore = quarantine.restore
    }

    try {
      const result = action === 'remove'
        ? removeGeneratedTool({ jokerHome, registryId: registry.registryId, expectedRevision: input.expectedRevision, operationId: input.operationId, createdAt: now(), toolId })
        : action === 'disable'
          ? disableGeneratedTool({ jokerHome, registryId: registry.registryId, expectedRevision: input.expectedRevision, operationId: input.operationId, createdAt: now(), toolId })
          : action === 'reenable'
            ? promoteGeneratedTool({ jokerHome, registryId: registry.registryId, expectedRevision: input.expectedRevision, operationId: input.operationId, createdAt: now(), toolId, versionId: versionId as string })
            : action === 'rollback'
              ? rollbackGeneratedTool({ jokerHome, registryId: registry.registryId, expectedRevision: input.expectedRevision, operationId: input.operationId, createdAt: now(), toolId, versionId: versionId as string })
              : revalidateGeneratedTool({ jokerHome, registryId: registry.registryId, expectedRevision: input.expectedRevision, operationId: input.operationId, createdAt: now(), toolId })
      const pointer = result.state.activePointers.find((item) => item.toolId === toolId)
      return { success: true, registryRevision: result.state.revision, capabilityRevision: result.state.capabilityRevision.revision, activeVersionId: pointer?.activeVersionId, ...(quarantineId ? { quarantineId } : {}) }
    } catch (error) {
      if (restore) {
        try { restore() } catch { /* leave quarantine for recoverable manual inspection */ }
      }
      throw error
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Generated Tool lifecycle mutation failed' }
  }
}
