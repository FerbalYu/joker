export type RunKind = 'chat' | 'goal'

export type RunPhase =
  | 'starting'
  | 'running'
  | 'streaming'
  | 'tool'
  | 'goal-execution'
  | 'goal-validation'
  | 'error'
  | 'aborting'

export type RunTerminalReason = 'completed' | 'aborted' | 'error' | 'needs-user-action'

export interface ActiveRunSummary {
  windowId: number
  sessionId: string
  runId: string
  kind: RunKind
  phase: RunPhase
  startedAt: number
}

export type RunActivityEvent =
  | { type: 'start'; run: ActiveRunSummary }
  | { type: 'phase'; run: ActiveRunSummary }
  | { type: 'terminal'; run: ActiveRunSummary; reason: RunTerminalReason }

export type RunActivityListener = (event: RunActivityEvent) => void

export interface RunRegistration {
  windowId: number
  sessionId: string
  runId: string
  kind: RunKind
  phase?: RunPhase
  startedAt?: number
}

export type RunRecord<T> = ActiveRunSummary & { value: T }

export interface EndpointGeneration<T> {
  windowId: number
  generation: number
  value: T
}

/** Fences renderer-document resources with a monotonic generation per window. */
export class EndpointGenerationRegistry<T> {
  private readonly generations = new Map<number, number>()
  private readonly endpoints = new Map<number, EndpointGeneration<T>>()

  activate(windowId: number, value: T): EndpointGeneration<T> {
    const endpoint = { windowId, generation: (this.generations.get(windowId) ?? 0) + 1, value }
    this.generations.set(windowId, endpoint.generation)
    this.endpoints.set(windowId, endpoint)
    return endpoint
  }

  current(windowId: number): EndpointGeneration<T> | undefined {
    return this.endpoints.get(windowId)
  }

  isCurrent(endpoint: Pick<EndpointGeneration<T>, 'windowId' | 'generation'>): boolean {
    return this.endpoints.get(endpoint.windowId)?.generation === endpoint.generation
  }

  retire(windowId: number, generation?: number): EndpointGeneration<T> | undefined {
    const endpoint = this.endpoints.get(windowId)
    if (!endpoint || (generation !== undefined && endpoint.generation !== generation)) return undefined
    this.endpoints.delete(windowId)
    return endpoint
  }
}

/** Maintains exact run, session-owner, and window-owner indexes as one atomic unit. */
export class RunRegistry<T> {
  private readonly runs = new Map<string, RunRecord<T>>()
  private readonly sessionRuns = new Map<string, string>()
  private readonly windowRuns = new Map<number, Set<string>>()
  private readonly listeners = new Set<RunActivityListener>()

  register(registration: RunRegistration, value: T): RunRecord<T> | null {
    if (this.runs.has(registration.runId) || this.sessionRuns.has(registration.sessionId)) return null
    const record: RunRecord<T> = {
      ...registration,
      phase: registration.phase ?? 'starting',
      startedAt: registration.startedAt ?? Date.now(),
      value
    }
    this.runs.set(record.runId, record)
    this.sessionRuns.set(record.sessionId, record.runId)
    let windowRunIds = this.windowRuns.get(record.windowId)
    if (!windowRunIds) {
      windowRunIds = new Set()
      this.windowRuns.set(record.windowId, windowRunIds)
    }
    windowRunIds.add(record.runId)
    this.emit({ type: 'start', run: snapshot(record) })
    return record
  }

  get(runId: string): RunRecord<T> | undefined {
    return this.runs.get(runId)
  }

  getForSession(sessionId: string): RunRecord<T> | undefined {
    const runId = this.sessionRuns.get(sessionId)
    return runId ? this.runs.get(runId) : undefined
  }

  isSessionRunning(sessionId: string): boolean {
    return this.sessionRuns.has(sessionId)
  }

  list(windowId?: number): ActiveRunSummary[] {
    const records = windowId === undefined
      ? this.runs.values()
      : [...(this.windowRuns.get(windowId) ?? [])].flatMap((runId) => {
          const record = this.runs.get(runId)
          return record ? [record] : []
        })
    return [...records]
      .sort((left, right) => left.startedAt - right.startedAt || left.runId.localeCompare(right.runId))
      .map(snapshot)
  }

  updatePhase(runId: string, phase: RunPhase): boolean {
    const record = this.runs.get(runId)
    if (!record || record.phase === phase) return false
    record.phase = phase
    this.emit({ type: 'phase', run: snapshot(record) })
    return true
  }

  release(runId: string, reason: RunTerminalReason): RunRecord<T> | undefined {
    const record = this.runs.get(runId)
    if (!record) return undefined
    this.runs.delete(runId)
    if (this.sessionRuns.get(record.sessionId) === runId) this.sessionRuns.delete(record.sessionId)
    const windowRunIds = this.windowRuns.get(record.windowId)
    windowRunIds?.delete(runId)
    if (windowRunIds?.size === 0) this.windowRuns.delete(record.windowId)
    this.emit({ type: 'terminal', run: snapshot(record), reason })
    return record
  }

  subscribe(listener: RunActivityListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: RunActivityEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('Run activity listener failed', error)
      }
    }
  }
}

function snapshot<T>(record: RunRecord<T>): ActiveRunSummary {
  return {
    windowId: record.windowId,
    sessionId: record.sessionId,
    runId: record.runId,
    kind: record.kind,
    phase: record.phase,
    startedAt: record.startedAt
  }
}
