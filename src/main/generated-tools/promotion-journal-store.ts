import { join } from 'node:path'

import type { GeneratedToolPromotionJournal } from '../../shared/generated-tools'
import { canonicalGeneratedToolJson, parseGeneratedToolPromotionJournal } from '../../shared/generated-tools-schema'
import { readJsonWithBackupStrict, updateJsonWithBackupStrict } from '../store/atomic-json'
import { generatedToolsRoot } from './store'
import { ToolForgeCasError } from './registry'

interface PromotionJournalState {
  schemaVersion: 1
  revision: number
  journals: GeneratedToolPromotionJournal[]
}

function parseState(value: unknown): PromotionJournalState {
  if (!value || typeof value !== 'object') throw new Error('Invalid promotion journal state')
  const candidate = value as Partial<PromotionJournalState>
  if (candidate.schemaVersion !== 1 || !Number.isInteger(candidate.revision) || !Array.isArray(candidate.journals)) throw new Error('Invalid promotion journal state')
  const journals = candidate.journals.map(parseGeneratedToolPromotionJournal)
  if (new Set(journals.map((item) => item.id)).size !== journals.length) throw new Error('Promotion journal ids must be unique')
  if (new Set(journals.map((item) => item.idempotencyKey)).size !== journals.length) throw new Error('Promotion journal idempotency keys must be unique')
  return { schemaVersion: 1, revision: candidate.revision as number, journals }
}

function initialState(): PromotionJournalState {
  return { schemaVersion: 1, revision: 0, journals: [] }
}

export function getPromotionJournalPath(jokerHome: string): string {
  return join(generatedToolsRoot(jokerHome), 'promotion-journal.json')
}

export function readPromotionJournals(jokerHome: string): PromotionJournalState {
  return readJsonWithBackupStrict(getPromotionJournalPath(jokerHome), parseState) ?? initialState()
}

export function createPromotionJournal(jokerHome: string, journal: GeneratedToolPromotionJournal): GeneratedToolPromotionJournal {
  const parsed = parseGeneratedToolPromotionJournal(journal)
  let result = parsed
  updateJsonWithBackupStrict(getPromotionJournalPath(jokerHome), parseState, initialState, (current) => {
    const existing = current.journals.find((item) => item.id === parsed.id || item.idempotencyKey === parsed.idempotencyKey)
    if (existing) {
      if (canonicalGeneratedToolJson(existing) !== canonicalGeneratedToolJson(parsed)) throw new ToolForgeCasError('Promotion journal identity already exists with different content')
      result = existing
      return current
    }
    result = parsed
    return { schemaVersion: 1 as const, revision: current.revision + 1, journals: [...current.journals, parsed] }
  })
  return result
}

export function updatePromotionJournal(
  jokerHome: string,
  journalId: string,
  expectedRevision: number,
  update: (journal: GeneratedToolPromotionJournal) => GeneratedToolPromotionJournal
): GeneratedToolPromotionJournal {
  let result: GeneratedToolPromotionJournal | undefined
  updateJsonWithBackupStrict(getPromotionJournalPath(jokerHome), parseState, initialState, (state) => {
    const index = state.journals.findIndex((item) => item.id === journalId)
    if (index < 0) throw new Error(`Promotion journal not found: ${journalId}`)
    const current = state.journals[index]
    if (current.revision !== expectedRevision) throw new ToolForgeCasError('Promotion journal revision is stale')
    const next = parseGeneratedToolPromotionJournal(update(structuredClone(current)))
    if (next.id !== current.id || next.idempotencyKey !== current.idempotencyKey || next.jobId !== current.jobId || next.toolId !== current.toolId || next.revision !== current.revision + 1) throw new Error('Promotion journal identity or revision changed incorrectly')
    if (next.updatedAt < current.updatedAt) throw new Error('Promotion journal updatedAt cannot move backwards')
    const journals = [...state.journals]
    journals[index] = next
    result = next
    return { schemaVersion: 1 as const, revision: state.revision + 1, journals }
  })
  if (!result) throw new Error('Promotion journal update did not produce a record')
  return result
}

export function readPromotionJournal(jokerHome: string, journalId: string): GeneratedToolPromotionJournal | null {
  return readPromotionJournals(jokerHome).journals.find((item) => item.id === journalId) ?? null
}

export function readPromotionJournalByIdempotencyKey(jokerHome: string, idempotencyKey: string): GeneratedToolPromotionJournal | null {
  return readPromotionJournals(jokerHome).journals.find((item) => item.idempotencyKey === idempotencyKey) ?? null
}
