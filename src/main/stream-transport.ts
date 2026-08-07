import {
  STREAM_HIGH_WATER_MARK,
  STREAM_TERMINAL_RESERVE,
  STREAM_TRANSPORT_VERSION,
  type StreamEvent,
  type StreamEventEnvelope,
  type StreamFlowState
} from '../shared/types'

interface PendingSend {
  event: StreamEvent
  runId: string
  terminal: boolean
  signal?: AbortSignal
  resolve: () => void
  reject: (error: Error) => void
  abortListener?: () => void
}

interface RunCounters {
  sentCount: number
  ackCount: number
  maxQueueDepth: number
  maxInFlight: number
  blockedSends: number
  resumedCount: number
  drainCount: number
}

export interface StreamTransportOptions {
  highWaterMark?: number
  terminalReserve?: number
  maxPending?: number
  maxCompletedRuns?: number
  postMessage: (message: StreamEventEnvelope | { type: 'stream:flow'; flow: StreamFlowState }) => void
  onFlow?: (flow: StreamFlowState) => void
}

export interface StreamTransportSnapshot {
  ready: boolean
  closed: boolean
  queueDepth: number
  pending: number
  blockedPending: number
  inFlight: number
  availableCredit: number
  maxQueueDepth: number
  maxInFlight: number
  sentCount: number
  ackCount: number
  blockedSends: number
  resumedCount: number
  drainCount: number
  highWaterMark: number
  terminalReserve: number
  runId?: string
  runs: Record<string, RunCounters>
}

const TERMINAL_EVENTS = new Set<StreamEvent['type']>(['message-end', 'context-usage', 'error', 'abort', 'done'])

function toError(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(typeof reason === 'string' ? reason : fallback)
}

/**
 * Application-level flow control for the transferred MessagePort.
 * queueDepth is the number of accepted envelopes (pending + in-flight), not
 * Electron's private byte queue. send() resolves once an envelope is posted;
 * when the window is full, it waits for an ACK before accepting the event.
 */
export class StreamTransport {
  private readonly highWaterMark: number
  private readonly terminalReserve: number
  private readonly maxPending: number
  private readonly maxCompletedRuns: number
  private readonly postMessage: StreamTransportOptions['postMessage']
  private readonly onFlow?: StreamTransportOptions['onFlow']
  private readonly pending: PendingSend[] = []
  private readonly blocked: PendingSend[] = []
  private readonly inFlight = new Map<number, { runId: string; terminal: boolean }>()
  private readonly runs = new Map<string, RunCounters>()
  private nextSeq = 1
  private readyState = false
  private closedState = false
  private credit = 0
  private maxQueueDepthValue = 0
  private maxInFlightValue = 0
  private sentCountValue = 0
  private ackCountValue = 0
  private blockedSendsValue = 0
  private resumedCountValue = 0
  private drainCountValue = 0
  private wasNonEmpty = false
  private lastRunId: string | undefined

  constructor(options: StreamTransportOptions) {
    const requestedHwm = Math.floor(options.highWaterMark ?? STREAM_HIGH_WATER_MARK)
    this.highWaterMark = Math.max(2, requestedHwm)
    const requestedReserve = Math.floor(options.terminalReserve ?? STREAM_TERMINAL_RESERVE)
    this.terminalReserve = Math.max(1, Math.min(this.highWaterMark - 1, requestedReserve))
    this.maxPending = Math.max(1, Math.floor(options.maxPending ?? this.highWaterMark))
    this.maxCompletedRuns = Math.max(0, Math.floor(options.maxCompletedRuns ?? 64))
    this.postMessage = options.postMessage
    this.onFlow = options.onFlow
  }

  ready(credit = this.highWaterMark): void {
    if (this.closedState) return
    this.readyState = true
    this.credit = Math.max(1, Math.min(this.highWaterMark, Math.floor(credit)))
    this.emitFlow('ready')
    this.pump()
  }

  send(event: StreamEvent, signal?: AbortSignal): Promise<void> {
    if (this.closedState) return Promise.reject(new Error('Stream transport is closed'))
    const runId = event.runId ?? ''
    const terminal = TERMINAL_EVENTS.has(event.type)
    if (signal?.aborted && !terminal) return Promise.reject(toError(signal.reason, 'Stream send aborted'))

    return new Promise<void>((resolve, reject) => {
      const item: PendingSend = { event, runId, terminal, signal, resolve, reject }
      if (signal && !terminal) {
        const onAbort = (): void => {
          const pendingIndex = this.pending.indexOf(item)
          const blockedIndex = this.blocked.indexOf(item)
          if (pendingIndex >= 0) this.pending.splice(pendingIndex, 1)
          if (blockedIndex >= 0) this.blocked.splice(blockedIndex, 1)
          if (pendingIndex >= 0 || blockedIndex >= 0) {
            this.removeAbortListener(item)
            reject(toError(signal.reason, 'Stream send aborted'))
            this.emitFlow('resumed', runId)
            this.pump()
            this.maybeDrain(runId)
          }
        }
        item.abortListener = onAbort
        signal.addEventListener('abort', onAbort, { once: true })
      }

      if (this.queueDepth() >= this.highWaterMark || (!terminal && this.inFlight.size >= Math.max(1, this.credit - this.terminalReserve))) {
        if (this.blocked.length >= this.maxPending) {
          this.removeAbortListener(item)
          reject(new Error('Stream transport pending queue is full'))
          return
        }
        this.blocked.push(item)
        this.blockedSendsValue += 1
        this.counter(runId).blockedSends += 1
        this.emitFlow('blocked', runId)
        return
      }

      this.pending.push(item)
      this.updateDepth(runId)
      this.emitFlow('queued', runId)
      this.pump()
    })
  }

  ack(seq: number, runId: string): boolean {
    const sent = this.inFlight.get(seq)
    if (!sent || sent.runId !== runId) return false
    this.inFlight.delete(seq)
    this.ackCountValue += 1
    this.counter(runId).ackCount += 1
    this.emitFlow('ack', runId)
    this.promoteBlocked()
    this.pump()
    this.maybeDrain(runId)
    this.pruneCompletedRuns()
    return true
  }

  cancelRun(runId: string, options: { drain?: boolean } = {}): void {
    this.rejectMatching(this.pending, runId, 'Stream run cancelled')
    this.rejectMatching(this.blocked, runId, 'Stream run cancelled')
    // Already-posted envelopes remain in-flight so their renderer ACKs are
    // still valid. Endpoint retirement passes drain:false because that
    // renderer document no longer owns the queue lifecycle.
    this.emitFlow('cancelled', runId)
    this.pump()
    if (options.drain !== false) this.maybeDrain(runId)
    this.pruneCompletedRuns()
  }

  close(reason = 'Stream transport closed'): void {
    if (this.closedState) return
    this.closedState = true
    const error = new Error(reason)
    for (const item of this.pending.splice(0)) {
      this.removeAbortListener(item)
      item.reject(error)
    }
    for (const item of this.blocked.splice(0)) {
      this.removeAbortListener(item)
      item.reject(error)
    }
    this.inFlight.clear()
    this.emitFlow('closed')
  }

  snapshot(): StreamTransportSnapshot {
    return {
      ready: this.readyState,
      closed: this.closedState,
      queueDepth: this.queueDepth(),
      pending: this.pending.length,
      blockedPending: this.blocked.length,
      inFlight: this.inFlight.size,
      availableCredit: Math.max(0, this.credit - this.inFlight.size),
      maxQueueDepth: this.maxQueueDepthValue,
      maxInFlight: this.maxInFlightValue,
      sentCount: this.sentCountValue,
      ackCount: this.ackCountValue,
      blockedSends: this.blockedSendsValue,
      resumedCount: this.resumedCountValue,
      drainCount: this.drainCountValue,
      highWaterMark: this.highWaterMark,
      terminalReserve: this.terminalReserve,
      runId: this.lastRunId,
      runs: Object.fromEntries([...this.runs.entries()].map(([id, counters]) => [id, { ...counters }]))
    }
  }

  private queueDepth(): number {
    return this.pending.length + this.inFlight.size
  }

  private canSend(item: PendingSend): boolean {
    if (!this.readyState || this.closedState) return false
    if (this.inFlight.size >= this.credit) return false
    if (!item.terminal && this.inFlight.size >= Math.max(1, this.credit - this.terminalReserve)) return false
    return true
  }

  private pump(): void {
    if (!this.readyState || this.closedState) return
    while (true) {
      const index = this.pending.findIndex((item) => this.canSend(item))
      if (index < 0) break
      const item = this.pending.splice(index, 1)[0]
      this.removeAbortListener(item)
      const seq = this.nextSeq++
      this.inFlight.set(seq, { runId: item.runId, terminal: item.terminal })
      this.lastRunId = item.runId || undefined
      this.sentCountValue += 1
      this.counter(item.runId).sentCount += 1
      this.updateDepth(item.runId)
      try {
        this.postMessage({ type: 'stream:event', seq, runId: item.runId, event: item.event })
        item.resolve()
      } catch (error) {
        this.inFlight.delete(seq)
        item.reject(toError(error, 'Failed to post stream event'))
      }
    }
    this.maybeDrain(this.lastRunId)
  }

  private promoteBlocked(): void {
    while (this.blocked.length > 0 && this.queueDepth() < this.highWaterMark) {
      const item = this.blocked.shift() as PendingSend
      if (!item.terminal && this.inFlight.size >= Math.max(1, this.credit - this.terminalReserve)) {
        this.blocked.unshift(item)
        break
      }
      this.pending.push(item)
      this.resumedCountValue += 1
      this.counter(item.runId).resumedCount += 1
      this.emitFlow('resumed', item.runId)
    }
  }

  private maybeDrain(runId?: string): void {
    if (this.queueDepth() !== 0 || this.blocked.length !== 0) {
      this.wasNonEmpty = true
      return
    }
    if (!this.wasNonEmpty) return
    this.wasNonEmpty = false
    this.drainCountValue += 1
    if (runId) this.counter(runId).drainCount += 1
    this.emitFlow('drain', runId)
  }

  private updateDepth(runId?: string): void {
    const depth = this.queueDepth()
    this.maxQueueDepthValue = Math.max(this.maxQueueDepthValue, depth)
    this.maxInFlightValue = Math.max(this.maxInFlightValue, this.inFlight.size)
    if (runId) {
      const counters = this.counter(runId)
      counters.maxQueueDepth = Math.max(counters.maxQueueDepth, depth)
      counters.maxInFlight = Math.max(counters.maxInFlight, this.inFlight.size)
    }
  }

  private counter(runId: string): RunCounters {
    let counters = this.runs.get(runId)
    if (!counters) {
      counters = { sentCount: 0, ackCount: 0, maxQueueDepth: 0, maxInFlight: 0, blockedSends: 0, resumedCount: 0, drainCount: 0 }
      this.runs.set(runId, counters)
    }
    return counters
  }

  private pruneCompletedRuns(): void {
    if (this.maxCompletedRuns < 0) return
    const activeRunIds = new Set<string>()
    for (const item of this.pending) activeRunIds.add(item.runId)
    for (const item of this.blocked) activeRunIds.add(item.runId)
    for (const item of this.inFlight.values()) activeRunIds.add(item.runId)
    const completed = [...this.runs.keys()].filter((runId) => !activeRunIds.has(runId))
    for (const runId of completed.slice(0, Math.max(0, completed.length - this.maxCompletedRuns))) this.runs.delete(runId)
  }

  private rejectMatching(items: PendingSend[], runId: string, message: string): void {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index]
      if (item.runId !== runId) continue
      items.splice(index, 1)
      this.removeAbortListener(item)
      item.reject(new Error(message))
    }
  }

  private removeAbortListener(item: PendingSend): void {
    if (item.signal && item.abortListener) item.signal.removeEventListener('abort', item.abortListener)
    item.abortListener = undefined
  }

  private emitFlow(event: StreamFlowState['event'], runId?: string): void {
    const snapshot = this.snapshot()
    this.onFlow?.({
      contractVersion: STREAM_TRANSPORT_VERSION,
      event,
      ...snapshot,
      runId: runId ?? snapshot.runId
    })
  }
}

export { STREAM_HIGH_WATER_MARK, STREAM_TERMINAL_RESERVE, STREAM_TRANSPORT_VERSION }
