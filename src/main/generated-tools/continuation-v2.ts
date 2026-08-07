import { join } from 'node:path'

import type { ToolForgeContinuationV2 } from '../../shared/generated-tools'
import { canonicalGeneratedToolJson, parseToolForgeContinuationV2 } from '../../shared/generated-tools-schema'
import { readJsonWithBackupStrict, updateJsonWithBackupStrict } from '../store/atomic-json'
import { generatedToolsRoot } from './store'
import { ToolForgeCasError } from './registry'

interface ContinuationV2State {
  schemaVersion: 2
  revision: number
  continuations: ToolForgeContinuationV2[]
}

function parseState(value: unknown): ContinuationV2State {
  if (!value || typeof value !== 'object') throw new Error('Invalid continuation v2 state')
  const candidate = value as Partial<ContinuationV2State>
  if (candidate.schemaVersion !== 2 || !Number.isInteger(candidate.revision) || !Array.isArray(candidate.continuations)) throw new Error('Invalid continuation v2 state')
  const continuations = candidate.continuations.map(parseToolForgeContinuationV2)
  if (new Set(continuations.map((item) => item.id)).size !== continuations.length) throw new Error('Continuation v2 ids must be unique')
  if (new Set(continuations.map((item) => `${item.jobId}:${item.toCapabilityRevision}`)).size !== continuations.length) throw new Error('Continuation v2 job/revision keys must be unique')
  return { schemaVersion: 2, revision: candidate.revision as number, continuations }
}

function initialState(): ContinuationV2State {
  return { schemaVersion: 2, revision: 0, continuations: [] }
}

export function getContinuationV2StorePath(jokerHome: string): string {
  return join(generatedToolsRoot(jokerHome), 'continuations-v2.json')
}

export function readContinuationV2State(jokerHome: string): ContinuationV2State {
  return readJsonWithBackupStrict(getContinuationV2StorePath(jokerHome), parseState) ?? initialState()
}

export function createContinuationV2(jokerHome: string, continuation: ToolForgeContinuationV2): { continuation: ToolForgeContinuationV2; idempotent: boolean } {
  const parsed = parseToolForgeContinuationV2(continuation)
  let result = parsed
  let idempotent = false
  updateJsonWithBackupStrict(getContinuationV2StorePath(jokerHome), parseState, initialState, (current) => {
    const existing = current.continuations.find((item) => item.id === parsed.id || (item.jobId === parsed.jobId && item.toCapabilityRevision === parsed.toCapabilityRevision))
    if (existing) {
      if (canonicalGeneratedToolJson(existing) !== canonicalGeneratedToolJson(parsed)) throw new ToolForgeCasError('Continuation v2 identity already exists with different content')
      result = existing
      idempotent = true
      return current
    }
    result = parsed
    return { schemaVersion: 2 as const, revision: current.revision + 1, continuations: [...current.continuations, parsed] }
  })
  return { continuation: result, idempotent }
}

export function updateContinuationV2(
  jokerHome: string,
  continuationId: string,
  expectedRevision: number,
  update: (current: ToolForgeContinuationV2) => ToolForgeContinuationV2
): ToolForgeContinuationV2 {
  let result: ToolForgeContinuationV2 | undefined
  updateJsonWithBackupStrict(getContinuationV2StorePath(jokerHome), parseState, initialState, (state) => {
    const index = state.continuations.findIndex((item) => item.id === continuationId)
    if (index < 0) throw new Error(`Continuation v2 not found: ${continuationId}`)
    const current = state.continuations[index]
    if (current.revision !== expectedRevision) throw new ToolForgeCasError('Continuation v2 revision is stale')
    const next = parseToolForgeContinuationV2(update(structuredClone(current)))
    if (next.id !== current.id || next.jobId !== current.jobId || next.toolId !== current.toolId || next.versionId !== current.versionId || next.revision !== current.revision + 1) throw new Error('Continuation v2 identity or revision changed incorrectly')
    if (next.updatedAt < current.updatedAt) throw new Error('Continuation v2 updatedAt cannot move backwards')
    result = next
    const continuations = [...state.continuations]
    continuations[index] = next
    return { schemaVersion: 2 as const, revision: state.revision + 1, continuations }
  })
  if (!result) throw new Error('Continuation v2 update did not produce a record')
  return result
}

export function readContinuationV2(jokerHome: string, id: string): ToolForgeContinuationV2 | null {
  return readContinuationV2State(jokerHome).continuations.find((item) => item.id === id) ?? null
}
