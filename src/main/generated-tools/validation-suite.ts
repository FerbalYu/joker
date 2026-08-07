import { createHash } from 'node:crypto'

import type { GeneratedToolCandidate } from '../../shared/generated-tools'
import { canonicalGeneratedToolJson } from '../../shared/generated-tools-schema'

export type GeneratedToolValidationExpectation =
  | { outcome: 'succeeded'; output: unknown }
  | { outcome: 'tool-failed'; error: unknown }

export interface GeneratedToolValidationCase {
  id: string
  input: Record<string, unknown>
  workspaceFiles: Record<string, string>
  expected: GeneratedToolValidationExpectation
}

export interface GeneratedToolValidationSuite {
  id: string
  toolId: string
  cases: GeneratedToolValidationCase[]
}

const suites = new Map<string, GeneratedToolValidationSuite>()

export const SUMMARIZE_TASK_JSON_VALIDATION_SUITE: GeneratedToolValidationSuite = {
  id: 'summarize-task-json-v1',
  toolId: 'summarize-task-json',
  cases: [
    {
      id: 'success-counts',
      input: {},
      workspaceFiles: {
        'fixtures/tasks.json': JSON.stringify([
          ...Array.from({ length: 4 }, () => ({ status: 'open' })),
          ...Array.from({ length: 3 }, () => ({ status: 'done' })),
          ...Array.from({ length: 2 }, () => ({ status: 'in_progress' }))
        ])
      },
      expected: { outcome: 'succeeded', output: 'open: 4\ndone: 3\nin_progress: 2' }
    },
    {
      id: 'invalid-json',
      input: {},
      workspaceFiles: { 'fixtures/tasks.json': '{invalid json' },
      expected: { outcome: 'tool-failed', error: { message: 'invalid-task-json' } }
    }
  ]
}

export const ELECTRON_VERTICAL_SLICE_VALIDATION_SUITE: GeneratedToolValidationSuite = {
  id: 'electron-vertical-slice-task-summary-v1',
  toolId: 'electron-vertical-slice-task-summary',
  cases: [
    {
      id: 'success',
      input: {},
      workspaceFiles: {
        'fixtures/tasks.json': JSON.stringify([{ status: 'open' }, { status: 'open' }, { status: 'done' }])
      },
      expected: { outcome: 'succeeded', output: 'open: 2\ndone: 1' }
    },
    {
      id: 'invalid-json',
      input: {},
      workspaceFiles: { 'fixtures/tasks.json': '{invalid json' },
      expected: { outcome: 'tool-failed', error: { message: 'invalid-task-json' } }
    }
  ]
}

export const GATE2_QUALIFICATION_VALIDATION_SUITE: GeneratedToolValidationSuite = {
  id: 'gate2-qualification-v1',
  toolId: 'gate2-qualification-tool',
  cases: [
    { id: 'success', input: {}, workspaceFiles: {}, expected: { outcome: 'succeeded', output: 'ok' } },
    { id: 'explicit-failure', input: { fail: true }, workspaceFiles: {}, expected: { outcome: 'tool-failed', error: { message: 'expected-failure' } } }
  ]
}

suites.set(SUMMARIZE_TASK_JSON_VALIDATION_SUITE.id, SUMMARIZE_TASK_JSON_VALIDATION_SUITE)
suites.set(GATE2_QUALIFICATION_VALIDATION_SUITE.id, GATE2_QUALIFICATION_VALIDATION_SUITE)
suites.set(ELECTRON_VERTICAL_SLICE_VALIDATION_SUITE.id, ELECTRON_VERTICAL_SLICE_VALIDATION_SUITE)

export function registerGeneratedToolValidationSuite(suite: GeneratedToolValidationSuite): void {
  const existing = suites.get(suite.id)
  if (existing && canonicalGeneratedToolJson(existing) !== canonicalGeneratedToolJson(suite)) {
    throw new Error(`Validation suite already exists with different content: ${suite.id}`)
  }
  suites.set(suite.id, structuredClone(suite))
}

export function resolveGeneratedToolValidationSuite(toolId: string): {
  suite: GeneratedToolValidationSuite
  hash: string
} {
  const matches = [...suites.values()].filter((suite) => suite.toolId === toolId)
  if (matches.length === 0) throw new Error(`No host-owned validation suite is registered for Generated Tool: ${toolId}`)
  if (matches.length > 1) throw new Error(`Generated Tool validation suite is ambiguous: ${toolId}`)
  const suite = structuredClone(matches[0])
  return { suite, hash: fingerprintGeneratedToolValidationSuite(suite) }
}

export function getGeneratedToolValidationSuite(candidate: Pick<GeneratedToolCandidate, 'validationSuiteId' | 'validationSuiteHash' | 'toolId'>): GeneratedToolValidationSuite {
  const suite = suites.get(candidate.validationSuiteId)
  if (!suite) throw new Error(`Unknown Generated Tool validation suite: ${candidate.validationSuiteId}`)
  if (suite.toolId !== candidate.toolId) throw new Error('Validation suite toolId does not match candidate')
  if (fingerprintGeneratedToolValidationSuite(suite) !== candidate.validationSuiteHash) throw new Error('Validation suite hash does not match candidate')
  return structuredClone(suite)
}

export function fingerprintGeneratedToolValidationSuite(suite: GeneratedToolValidationSuite): string {
  return createHash('sha256').update(canonicalGeneratedToolJson(suite)).digest('hex')
}
