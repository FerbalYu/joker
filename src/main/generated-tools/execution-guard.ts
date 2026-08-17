import type { ToolGuard } from '../tools/registry'
import { readGeneratedToolRegistry } from './registry'
import { readGeneratedToolVersion } from './version-store'
import type { GeneratedToolRegistryState } from '../../shared/generated-tools'

export interface GeneratedToolExecutionGuardDependencies {
  /** Test seam; defaults to the real registry reader. */
  readRegistry?: (jokerHome: string) => GeneratedToolRegistryState
}

/**
 * Final-execution-boundary guard for Generated Tools. The ToolDefinition
 * snapshot (fingerprint, pointer/capability revisions, active version) was
 * fixed when the ToolSet was built; this guard re-verifies each fact against
 * the live registry at the moment of execution. It can only deny, never
 * re-allow. Workspace trust is intentionally not re-checked here: the
 * maintained full-trust policy already expresses the authorization decision,
 * and this guard must not contradict it.
 */
export function generatedToolExecutionGuard(
  jokerHome: string,
  dependencies: GeneratedToolExecutionGuardDependencies = {}
): ToolGuard {
  const readRegistry = dependencies.readRegistry ?? readGeneratedToolRegistry
  return (exec) => {
    const source = exec.definition.source
    if (source?.type !== 'generated') return undefined
    if (!exec.context.workspacePath) return 'Generated Tool execution requires a workspace'
    const registry = readRegistry(jokerHome)
    const pointer = registry.activePointers.find((item) => item.toolId === source.toolId)
    const entry = registry.entries.find((item) => item.toolId === source.toolId)
    if (!pointer || !entry) return `Generated Tool ${source.toolId} is not registered`
    if (entry.descriptor.availability !== 'available' || pointer.activeVersionId !== source.versionId
      || entry.descriptor.activeVersionId !== source.versionId) {
      return 'Generated Tool is no longer active'
    }
    if (pointer.revision !== source.pointerRevision) {
      return 'Generated Tool pointer revision changed; re-resolve the ToolSet'
    }
    if (registry.capabilityRevision.revision !== source.capabilityRevision) {
      return 'Generated Tool capability revision changed; re-resolve the ToolSet'
    }
    const version = readGeneratedToolVersion(jokerHome, source.toolId, source.versionId)
    if (version.fingerprint !== source.fingerprint) {
      return 'Generated Tool fingerprint mismatch at the execution boundary'
    }
    return undefined
  }
}
