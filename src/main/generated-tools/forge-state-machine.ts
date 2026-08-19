import type { ForgeJobStatus } from '../../shared/generated-tools'

// interrupted is terminal for reporting, but the durable store permits controlled recovery transitions.
const terminal = new Set<ForgeJobStatus>(['completed', 'failed', 'cancelled', 'interrupted'])
const allowed: Record<ForgeJobStatus, readonly ForgeJobStatus[]> = {
  queued: ['planning', 'failed', 'cancelled'],
  planning: ['building', 'failed', 'cancelled'],
  building: ['validating', 'failed', 'cancelled', 'interrupted'],
  validating: ['building', 'awaiting-policy', 'failed', 'cancelled', 'interrupted'],
  'awaiting-policy': ['building', 'promoting', 'failed', 'cancelled'],
  promoting: ['completed', 'failed', 'interrupted'],
  completed: [],
  failed: ['building'],
  cancelled: [],
  interrupted: ['planning', 'building', 'validating']
}

export function isForgeJobTerminal(status: ForgeJobStatus): boolean { return terminal.has(status) }

export function canTransitionForgeJob(from: ForgeJobStatus, to: ForgeJobStatus): boolean {
  return from === to || allowed[from].includes(to)
}

export function assertForgeJobTransition(from: ForgeJobStatus, to: ForgeJobStatus): void {
  if (!canTransitionForgeJob(from, to)) throw new Error(`Invalid ForgeJob transition: ${from} -> ${to}`)
}
