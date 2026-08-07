import { createHash } from 'node:crypto'
import { join } from 'node:path'

import type { GeneratedToolInvocation, GeneratedToolInvocationState } from '../../shared/generated-tools'
import { canonicalGeneratedToolJson, parseGeneratedToolInvocationState } from '../../shared/generated-tools-schema'
import { readJsonWithBackupStrict, updateJsonWithBackupStrict } from '../store/atomic-json'
import { generatedToolsRoot } from './store'
import { ToolForgeCasError } from './registry'

export interface ProposeGeneratedToolInvocationInput {
  id: string
  idempotencyKey: string
  toolId: string
  versionId: string
  fingerprint: string
  sessionId: string
  runId: string
  toolCallId: string
  capabilityRevision: number
  request: unknown
  proposedAt: number
}

const MAX_INVOCATION_REQUEST_BYTES = 1_000_000

function hashInvocationRequest(value: unknown): string {
  const canonical = canonicalGeneratedToolJson(value)
  const bytes = Buffer.byteLength(canonical, 'utf8')
  if (bytes > MAX_INVOCATION_REQUEST_BYTES) throw new Error('Generated Tool invocation request exceeds persistence hashing limit')
  return createHash('sha256').update(canonical).digest('hex')
}

export function getInvocationStorePath(jokerHome: string): string {
  return join(generatedToolsRoot(jokerHome), 'invocations.json')
}

function initialState(): GeneratedToolInvocationState {
  return { schemaVersion: 1, revision: 0, invocations: [] }
}

export function readGeneratedToolInvocations(jokerHome: string): GeneratedToolInvocationState {
  return readJsonWithBackupStrict(getInvocationStorePath(jokerHome), parseGeneratedToolInvocationState) ?? initialState()
}

export function proposeGeneratedToolInvocation(jokerHome: string, input: ProposeGeneratedToolInvocationInput): GeneratedToolInvocation {
  const requestHash = hashInvocationRequest(input.request)
  let result: GeneratedToolInvocation | undefined
  updateJsonWithBackupStrict(getInvocationStorePath(jokerHome), parseGeneratedToolInvocationState, initialState, (current) => {
    const prior = current.invocations.find((item) => item.idempotencyKey === input.idempotencyKey)
    if (prior) {
      if (prior.requestHash !== requestHash || prior.toolId !== input.toolId || prior.versionId !== input.versionId ||
        prior.fingerprint !== input.fingerprint || prior.sessionId !== input.sessionId || prior.runId !== input.runId ||
        prior.toolCallId !== input.toolCallId || prior.capabilityRevision !== input.capabilityRevision) {
        throw new ToolForgeCasError('Invocation idempotency key was reused with different content')
      }
      result = prior
      return current
    }
    if (current.invocations.some((item) => item.id === input.id)) throw new ToolForgeCasError('Invocation id already exists')
    result = {
      schemaVersion: 1,
      id: input.id,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      toolId: input.toolId,
      versionId: input.versionId,
      fingerprint: input.fingerprint,
      sessionId: input.sessionId,
      runId: input.runId,
      toolCallId: input.toolCallId,
      capabilityRevision: input.capabilityRevision,
      status: 'proposed',
      revision: 0,
      proposedAt: input.proposedAt
    }
    return parseGeneratedToolInvocationState({ ...current, revision: current.revision + 1, invocations: [...current.invocations, result] })
  })
  if (!result) throw new Error('Invocation proposal did not produce a record')
  return result
}

export function updateGeneratedToolInvocation(
  jokerHome: string,
  invocationId: string,
  expectedRevision: number,
  update: (current: GeneratedToolInvocation) => GeneratedToolInvocation
): GeneratedToolInvocation {
  let result: GeneratedToolInvocation | undefined
  updateJsonWithBackupStrict(getInvocationStorePath(jokerHome), parseGeneratedToolInvocationState, initialState, (state) => {
    const index = state.invocations.findIndex((item) => item.id === invocationId)
    if (index < 0) throw new Error(`Generated Tool invocation not found: ${invocationId}`)
    const current = state.invocations[index]
    if (current.revision !== expectedRevision) throw new ToolForgeCasError('Invocation revision is stale')
    const next = update(structuredClone(current))
    const legalTransition =
      (current.status === 'proposed' && next.status === 'policy') ||
      (current.status === 'policy' && ((current.policyDecision === 'deny' && next.status === 'finished') || (current.policyDecision !== 'deny' && next.status === 'started'))) ||
      (current.status === 'started' && next.status === 'finished')
    if (!legalTransition) throw new Error(`Invalid invocation lifecycle transition: ${current.status} -> ${next.status}`)
    if (next.id !== current.id || next.idempotencyKey !== current.idempotencyKey || next.requestHash !== current.requestHash ||
      next.toolId !== current.toolId || next.versionId !== current.versionId || next.fingerprint !== current.fingerprint ||
      next.sessionId !== current.sessionId || next.runId !== current.runId || next.toolCallId !== current.toolCallId ||
      next.capabilityRevision !== current.capabilityRevision || next.revision !== current.revision + 1) {
      throw new Error('Invocation lifecycle update changed immutable identity or did not increment revision')
    }
    const invocations = [...state.invocations]
    invocations[index] = next
    result = next
    return parseGeneratedToolInvocationState({ ...state, revision: state.revision + 1, invocations })
  })
  if (!result) throw new Error('Invocation update did not produce a record')
  return result
}
