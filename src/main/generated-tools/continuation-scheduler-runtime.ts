import type { ContinuationScheduler } from './continuation-scheduler'

let defaultContinuationScheduler: ContinuationScheduler | null = null

export function setDefaultContinuationScheduler(scheduler: ContinuationScheduler | null): void {
  defaultContinuationScheduler = scheduler
}

export function getDefaultContinuationScheduler(): ContinuationScheduler | undefined {
  return defaultContinuationScheduler ?? undefined
}
