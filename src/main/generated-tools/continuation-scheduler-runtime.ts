import type { ContinuationScheduler } from './continuation-scheduler'
import { getCordisContinuationScheduler } from './cordis-runtime'

let defaultContinuationScheduler: ContinuationScheduler | null = null

export function setDefaultContinuationScheduler(scheduler: ContinuationScheduler | null): void {
  defaultContinuationScheduler = scheduler
}

export function getDefaultContinuationScheduler(): ContinuationScheduler | undefined {
  return getCordisContinuationScheduler() ?? defaultContinuationScheduler ?? undefined
}
