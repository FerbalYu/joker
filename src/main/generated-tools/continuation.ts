import { join } from 'node:path'

import type { ToolForgeContinuationClaim, ToolForgeContinuationState } from '../../shared/generated-tools'
import { canonicalGeneratedToolJson, parseToolForgeContinuationState } from '../../shared/generated-tools-schema'
import { readJsonWithBackupStrict, updateJsonWithBackupStrict } from '../store/atomic-json'
import { generatedToolsRoot } from './store'
import { ToolForgeCasError } from './registry'

function initialState(): ToolForgeContinuationState {
  return { schemaVersion: 1, revision: 0, claims: [] }
}

export function getContinuationStorePath(jokerHome: string): string {
  return join(generatedToolsRoot(jokerHome), 'continuations.json')
}

export function readToolForgeContinuations(jokerHome: string): ToolForgeContinuationState {
  return readJsonWithBackupStrict(getContinuationStorePath(jokerHome), parseToolForgeContinuationState) ?? initialState()
}

export function claimToolForgeContinuation(jokerHome: string, claim: ToolForgeContinuationClaim): { claim: ToolForgeContinuationClaim; idempotent: boolean } {
  const parsedClaim = parseToolForgeContinuationState({ schemaVersion: 1, revision: 0, claims: [claim] }).claims[0]
  if (parsedClaim.status !== 'claimed' || parsedClaim.revision !== 0 || parsedClaim.continuationRunId !== undefined || parsedClaim.updatedAt !== parsedClaim.claimedAt) {
    throw new Error('New continuation claim must be unassigned claimed revision zero')
  }
  let result = parsedClaim
  let idempotent = false
  updateJsonWithBackupStrict(getContinuationStorePath(jokerHome), parseToolForgeContinuationState, initialState, (current) => {
    const prior = current.claims.find((item) => item.jobId === parsedClaim.jobId && item.capabilityRevision === parsedClaim.capabilityRevision)
    if (prior) {
      if (canonicalGeneratedToolJson(prior) !== canonicalGeneratedToolJson(parsedClaim)) {
        throw new ToolForgeCasError('Continuation claim already belongs to another request')
      }
      result = prior
      idempotent = true
      return current
    }
    const parsed = parseToolForgeContinuationState({ ...current, revision: current.revision + 1, claims: [...current.claims, parsedClaim] })
    result = parsed.claims[parsed.claims.length - 1]
    return parsed
  })
  return { claim: result, idempotent }
}

export function updateToolForgeContinuation(
  jokerHome: string,
  continuationId: string,
  expectedRevision: number,
  update: (current: ToolForgeContinuationClaim) => ToolForgeContinuationClaim
): ToolForgeContinuationClaim {
  let result: ToolForgeContinuationClaim | undefined
  updateJsonWithBackupStrict(getContinuationStorePath(jokerHome), parseToolForgeContinuationState, initialState, (state) => {
    const index = state.claims.findIndex((item) => item.id === continuationId)
    if (index < 0) throw new Error(`Continuation claim not found: ${continuationId}`)
    const current = state.claims[index]
    if (current.revision !== expectedRevision) throw new ToolForgeCasError('Continuation revision is stale')
    if (current.status !== 'claimed') throw new ToolForgeCasError('Continuation claim is already terminal')
    const next = update(structuredClone(current))
    if (next.status !== 'completed' && next.status !== 'cancelled') throw new Error('Continuation claim can only become completed or cancelled')
    if (next.updatedAt < current.updatedAt) throw new Error('Continuation updatedAt cannot move backwards')
    if (next.status === 'completed' && !next.continuationRunId) throw new Error('Completed continuation requires continuationRunId')
    if (next.status === 'cancelled' && next.continuationRunId !== undefined) throw new Error('Cancelled continuation cannot carry continuationRunId')
    if (next.id !== current.id || next.jobId !== current.jobId || next.capabilityRevision !== current.capabilityRevision ||
      next.sessionId !== current.sessionId || next.sourceRunId !== current.sourceRunId || next.revision !== current.revision + 1) {
      throw new Error('Continuation update changed immutable identity or did not increment revision')
    }
    const claims = [...state.claims]
    claims[index] = next
    result = next
    return parseToolForgeContinuationState({ ...state, revision: state.revision + 1, claims })
  })
  if (!result) throw new Error('Continuation update did not produce a record')
  return result
}
