import { join } from 'node:path'

import { z } from 'zod'

import { readJsonWithBackup, updateJsonWithBackup, writeJsonWithBackup } from '../store/atomic-json'
import { getJokerHomeDir } from '../store/paths'

export type QualificationOperationStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface QualificationOperationRecord {
  schemaVersion: 1
  attemptId: string
  status: QualificationOperationStatus
  phase?: string
  completedChecks: number
  totalChecks: number
  startedAt?: number
  updatedAt: number
  finishedAt?: number
  error?: string
}

const QualificationOperationSchema = z.object({
  schemaVersion: z.literal(1),
  attemptId: z.string().trim().min(1).max(128),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']),
  phase: z.string().trim().min(1).max(128).optional(),
  completedChecks: z.number().int().nonnegative(),
  totalChecks: z.number().int().positive(),
  startedAt: z.number().int().nonnegative().optional(),
  updatedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative().optional(),
  error: z.string().max(2_000).optional()
}).strict()

export function qualificationOperationPath(jokerHome = getJokerHomeDir()): string {
  return join(jokerHome, '.joker', 'qualification', 'operation.json')
}

export function readQualificationOperation(jokerHome = getJokerHomeDir()): QualificationOperationRecord | null {
  return readJsonWithBackup(qualificationOperationPath(jokerHome), (value) => QualificationOperationSchema.parse(value))
}

export function writeQualificationOperation(
  record: QualificationOperationRecord,
  jokerHome = getJokerHomeDir()
): QualificationOperationRecord {
  const parsed = QualificationOperationSchema.parse(record)
  writeJsonWithBackup(qualificationOperationPath(jokerHome), parsed)
  return parsed
}

export function updateQualificationOperation(
  jokerHome: string,
  update: (current: QualificationOperationRecord | null) => QualificationOperationRecord
): QualificationOperationRecord {
  return updateJsonWithBackup(
    qualificationOperationPath(jokerHome),
    (value) => QualificationOperationSchema.parse(value),
    () => {
      throw new Error('Qualification operation does not exist')
    },
    update
  )
}
