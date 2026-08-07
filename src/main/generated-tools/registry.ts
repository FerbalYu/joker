import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type {
  CapabilityRevisionReason,
  GeneratedToolActivePointer,
  GeneratedToolDescriptor,
  GeneratedToolRegistryEntry,
  GeneratedToolRegistryState,
  GeneratedToolVersion
} from '../../shared/generated-tools'
import { canonicalGeneratedToolJson, parseGeneratedToolRegistryState, parseGeneratedToolVersion } from '../../shared/generated-tools-schema'
import { readJsonWithBackupStrict, updateJsonWithBackupStrict, writeJsonOnce } from '../store/atomic-json'
import { generatedToolsRoot, verifyPublishedGeneratedToolBundle } from './store'

export class ToolForgeCasError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolForgeCasError'
  }
}

export interface RegistryMutationResult {
  entries?: GeneratedToolRegistryEntry[]
  activePointers?: GeneratedToolActivePointer[]
  capabilityChange?: {
    reason: Exclude<CapabilityRevisionReason, 'initial'>
    toolIds: string[]
    changedAt: number
  }
}

export interface RegistryMutationInput {
  jokerHome: string
  registryId: string
  expectedRevision: number
  operationId: string
  kind: string
  operationPayload: unknown
  createdAt: number
  mutate: (current: GeneratedToolRegistryState) => RegistryMutationResult
}

export interface GeneratedToolRegistryOperationInput {
  jokerHome: string
  registryId: string
  expectedRevision: number
  operationId: string
  createdAt: number
}

export function registerGeneratedToolVersion(
  input: GeneratedToolRegistryOperationInput & { descriptor: GeneratedToolDescriptor; version: GeneratedToolVersion }
): { state: GeneratedToolRegistryState; idempotent: boolean } {
  const verified = verifyPublishedGeneratedToolBundle(generatedToolsRoot(input.jokerHome), input.version)
  return mutateGeneratedToolRegistry({
    ...input,
    kind: 'register-version',
    operationPayload: { descriptor: input.descriptor, version: verified },
    mutate: (current) => {
      const existing = current.entries.find((entry) => entry.toolId === verified.toolId)
      if (existing?.versionIds.includes(verified.id)) return {}
      const existingVersions = existing?.versionIds.map((versionId) => readVersionForRegistry(input.jokerHome, verified.toolId, versionId)) ?? []
      const expectedVersionNumber = existingVersions.length === 0 ? 1 : Math.max(...existingVersions.map((version) => version.version)) + 1
      if (verified.version !== expectedVersionNumber || existing?.validationReportIds.includes(verified.validationReportId)) {
        throw new Error('Generated Tool version number and validation report must be strictly append-only')
      }
      if (input.descriptor.id !== verified.toolId || input.descriptor.activeVersionId !== undefined || input.descriptor.availability === 'available') {
        throw new Error('Registered Generated Tool version must not pre-authorize an active descriptor')
      }
      if (existing && (input.descriptor.scope !== existing.descriptor.scope || input.descriptor.projectId !== existing.descriptor.projectId)) {
        throw new Error('Generated Tool stable scope cannot change while registering a version')
      }
      const descriptor = existing?.descriptor ?? input.descriptor
      const entry: GeneratedToolRegistryEntry = {
        toolId: verified.toolId,
        descriptor,
        versionIds: [...(existing?.versionIds ?? []), verified.id],
        validationReportIds: [...(existing?.validationReportIds ?? []), verified.validationReportId],
        updatedAt: input.createdAt
      }
      return { entries: [...current.entries.filter((item) => item.toolId !== verified.toolId), entry] }
    }
  })
}

function switchGeneratedToolPointer(
  input: GeneratedToolRegistryOperationInput & { toolId: string; versionId?: string; kind: 'promote' | 'disable' | 'rollback' }
): { state: GeneratedToolRegistryState; idempotent: boolean } {
  return mutateGeneratedToolRegistry({
    ...input,
    kind: input.kind,
    operationPayload: { toolId: input.toolId, versionId: input.versionId },
    mutate: (current) => {
      const entry = current.entries.find((item) => item.toolId === input.toolId)
      if (!entry) throw new Error(`Generated Tool is not registered: ${input.toolId}`)
      if (input.versionId && !entry.versionIds.includes(input.versionId)) throw new Error('Target Generated Tool version is not registered')
      if (input.versionId) verifyPublishedGeneratedToolBundle(generatedToolsRoot(input.jokerHome), readVersionForRegistry(input.jokerHome, input.toolId, input.versionId))
      const prior = current.activePointers.find((item) => item.toolId === input.toolId)
      const nextPointer: GeneratedToolActivePointer = {
        schemaVersion: 1,
        toolId: input.toolId,
        revision: (prior?.revision ?? 0) + 1,
        activeVersionId: input.kind === 'disable' ? undefined : input.versionId,
        lastStableVersionId: input.kind === 'disable' ? prior?.lastStableVersionId : input.versionId,
        updatedAt: input.createdAt
      }
      const descriptor: GeneratedToolDescriptor = {
        ...entry.descriptor,
        availability: input.kind === 'disable' ? 'disabled' : 'available',
        activeVersionId: nextPointer.activeVersionId,
        lastStableVersionId: nextPointer.lastStableVersionId,
        updatedAt: input.createdAt
      }
      return {
        entries: current.entries.map((item) => item.toolId === input.toolId ? { ...item, descriptor, updatedAt: input.createdAt } : item),
        activePointers: [...current.activePointers.filter((item) => item.toolId !== input.toolId), nextPointer],
        capabilityChange: {
          reason: input.kind === 'promote' ? 'tool-promoted' : input.kind === 'disable' ? 'tool-disabled' : 'tool-rolled-back',
          toolIds: [input.toolId],
          changedAt: input.createdAt
        }
      }
    }
  })
}

export function promoteGeneratedTool(input: GeneratedToolRegistryOperationInput & { toolId: string; versionId: string }) {
  return switchGeneratedToolPointer({ ...input, kind: 'promote' })
}

export function disableGeneratedTool(input: GeneratedToolRegistryOperationInput & { toolId: string }) {
  return switchGeneratedToolPointer({ ...input, kind: 'disable' })
}

export function rollbackGeneratedTool(input: GeneratedToolRegistryOperationInput & { toolId: string; versionId: string }) {
  return switchGeneratedToolPointer({ ...input, kind: 'rollback' })
}

export function removeGeneratedTool(input: GeneratedToolRegistryOperationInput & { toolId: string }) {
  return mutateGeneratedToolRegistry({
    ...input,
    kind: 'remove',
    operationPayload: { toolId: input.toolId },
    mutate: (current) => {
      const entry = current.entries.find((item) => item.toolId === input.toolId)
      if (!entry) throw new Error(`Generated Tool is not registered: ${input.toolId}`)
      const pointer = current.activePointers.find((item) => item.toolId === input.toolId)
      if (pointer?.activeVersionId !== undefined) throw new Error('Cannot remove Generated Tool while an active version exists')
      return {
        entries: current.entries.filter((item) => item.toolId !== input.toolId),
        activePointers: current.activePointers.filter((item) => item.toolId !== input.toolId),
        capabilityChange: {
          reason: 'tool-removed',
          toolIds: [input.toolId],
          changedAt: input.createdAt
        }
      }
    }
  })
}

export function revalidateGeneratedTool(
  input: GeneratedToolRegistryOperationInput & { toolId: string }
): { state: GeneratedToolRegistryState; idempotent: boolean } {
  return mutateGeneratedToolRegistry({
    ...input,
    kind: 'revalidate',
    operationPayload: { toolId: input.toolId },
    mutate: (current) => {
      const entry = current.entries.find((item) => item.toolId === input.toolId)
      if (!entry) throw new Error(`Generated Tool is not registered: ${input.toolId}`)
      const pointer = current.activePointers.find((item) => item.toolId === input.toolId)
      if (!pointer?.activeVersionId) throw new Error('Generated Tool has no active version to revalidate')

      let availability: GeneratedToolDescriptor['availability'] = 'available'
      try {
        verifyPublishedGeneratedToolBundle(
          generatedToolsRoot(input.jokerHome),
          readVersionForRegistry(input.jokerHome, input.toolId, pointer.activeVersionId)
        )
      } catch {
        availability = 'changed'
      }

      const descriptor: GeneratedToolDescriptor = {
        ...entry.descriptor,
        availability,
        activeVersionId: pointer.activeVersionId,
        lastStableVersionId: pointer.lastStableVersionId,
        updatedAt: input.createdAt
      }
      return {
        entries: current.entries.map((item) => item.toolId === input.toolId
          ? { ...item, descriptor, updatedAt: input.createdAt }
          : item),
        capabilityChange: entry.descriptor.availability === availability
          ? undefined
          : {
              reason: 'tool-revalidated',
              toolIds: [input.toolId],
              changedAt: input.createdAt
            }
      }
    }
  })
}

function readVersionForRegistry(jokerHome: string, toolId: string, versionId: string): GeneratedToolVersion {
  const path = join(generatedToolsRoot(jokerHome), 'tools', toolId, 'versions', versionId, 'version.json')
  return parseGeneratedToolVersion(JSON.parse(readFileSync(path, 'utf8')))
}

export function getGeneratedToolRegistryPath(jokerHome: string): string {
  return join(generatedToolsRoot(jokerHome), 'registry.json')
}

function initialRegistry(): GeneratedToolRegistryState {
  return {
    schemaVersion: 1,
    registryId: randomUUID(),
    revision: 0,
    entries: [],
    activePointers: [],
    capabilityRevision: {
      schemaVersion: 1,
      revision: 0,
      changedAt: 0,
      reason: 'initial',
      toolIds: [],
      operationId: 'initial'
    },
    operations: []
  }
}

export function readGeneratedToolRegistry(jokerHome: string): GeneratedToolRegistryState {
  const path = getGeneratedToolRegistryPath(jokerHome)
  const existing = readJsonWithBackupStrict(path, parseGeneratedToolRegistryState)
  if (existing) return existing
  const created = initialRegistry()
  try {
    writeJsonOnce(path, created)
    return created
  } catch {
    const raced = readJsonWithBackupStrict(path, parseGeneratedToolRegistryState)
    if (!raced) throw new Error('Generated Tool registry initialization failed')
    return raced
  }
}

function mutateGeneratedToolRegistry(input: RegistryMutationInput): { state: GeneratedToolRegistryState; idempotent: boolean } {
  let idempotent = false
  const operationHash = createHash('sha256').update(canonicalGeneratedToolJson({
    kind: input.kind,
    payload: input.operationPayload
  })).digest('hex')
  const state = updateJsonWithBackupStrict(
    getGeneratedToolRegistryPath(input.jokerHome),
    parseGeneratedToolRegistryState,
    () => ({ ...initialRegistry(), registryId: input.registryId }),
    (current) => {
      if (current.registryId !== input.registryId) throw new ToolForgeCasError('Generated Tool registry identity changed')
      const prior = current.operations.find((record) => record.operationId === input.operationId)
      if (prior) {
        if (prior.operationHash !== operationHash || prior.kind !== input.kind) throw new ToolForgeCasError('Operation id was already used with different content')
        idempotent = true
        return current
      }
      if (current.revision !== input.expectedRevision) throw new ToolForgeCasError('Generated Tool registry revision is stale')
      const mutation = input.mutate(structuredClone(current))
      const revision = current.revision + 1
      const capabilityRevision = mutation.capabilityChange
        ? {
            schemaVersion: 1 as const,
            revision: current.capabilityRevision.revision + 1,
            changedAt: mutation.capabilityChange.changedAt,
            reason: mutation.capabilityChange.reason,
            toolIds: [...new Set(mutation.capabilityChange.toolIds)].sort((left, right) => left.localeCompare(right, 'en-US')),
            operationId: input.operationId
          }
        : current.capabilityRevision
      return parseGeneratedToolRegistryState({
        ...current,
        revision,
        entries: mutation.entries ?? current.entries,
        activePointers: mutation.activePointers ?? current.activePointers,
        capabilityRevision,
        operations: [...current.operations, {
          operationId: input.operationId,
          operationHash,
          kind: input.kind,
          appliedRevision: revision,
          createdAt: input.createdAt
        }]
      })
    }
  )
  return { state, idempotent }
}
