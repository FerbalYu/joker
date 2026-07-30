import type { StreamEvent } from '@shared/types'

export interface ActiveRendererRun {
  runId: string
  sessionId: string
  abortRequested?: boolean
}

export function requestRunAbort(run: ActiveRendererRun | null): ActiveRendererRun | null {
  return run ? { ...run, abortRequested: true } : null
}

export function acceptsRunEvent(run: ActiveRendererRun | null, event: Pick<StreamEvent, 'type' | 'runId'>): boolean {
  if (run) return event.runId === run.runId
  return event.type === 'done'
}

export function completeRunOnEvent(run: ActiveRendererRun | null, event: Pick<StreamEvent, 'type' | 'runId'>): ActiveRendererRun | null {
  return run && event.type === 'done' && event.runId === run.runId ? null : run
}
