import type { StreamEvent } from '@shared/types'

export interface ActiveRendererRun {
  runId: string
  sessionId: string
  abortRequested?: boolean
}

export type ActiveRendererRuns = Record<string, ActiveRendererRun>

type RoutedRunEvent = Pick<StreamEvent, 'type' | 'runId' | 'sessionId'> & { disposition?: 'queue' | 'steer' }

export function activeRunForSession(runs: ActiveRendererRuns, sessionId: string): ActiveRendererRun | null {
  return runs[sessionId] ?? null
}

export function setActiveRun(runs: ActiveRendererRuns, run: ActiveRendererRun): ActiveRendererRuns {
  return { ...runs, [run.sessionId]: run }
}

export function clearActiveRun(runs: ActiveRendererRuns, sessionId: string, runId?: string): ActiveRendererRuns {
  const active = runs[sessionId]
  if (!active || (runId && active.runId !== runId)) return runs
  const { [sessionId]: _removed, ...remaining } = runs
  return remaining
}

export function requestRunAbort(runs: ActiveRendererRuns, sessionId: string): ActiveRendererRuns {
  const active = runs[sessionId]
  return active ? { ...runs, [sessionId]: { ...active, abortRequested: true } } : runs
}

export function adoptQueuedRunOnEvent(runs: ActiveRendererRuns, event: RoutedRunEvent): ActiveRendererRuns {
  if (runs[event.sessionId] || event.type !== 'message-applied' || event.disposition !== 'queue' || !event.runId) return runs
  return setActiveRun(runs, { runId: event.runId, sessionId: event.sessionId })
}

export function acceptsRunEvent(runs: ActiveRendererRuns, event: RoutedRunEvent): boolean {
  const active = runs[event.sessionId]
  if (active) return event.runId === active.runId
  return event.type === 'done'
}

export function completeRunOnEvent(runs: ActiveRendererRuns, event: RoutedRunEvent): ActiveRendererRuns {
  return event.type === 'done' ? clearActiveRun(runs, event.sessionId, event.runId) : runs
}
