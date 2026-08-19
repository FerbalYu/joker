import { randomUUID } from 'node:crypto'

export interface TraceSpan {
  traceId: string
  spanId: string
  name: string
  startedAt: number
  endedAt?: number
  status?: 'ok' | 'error'
  attributes: Record<string, string | number | boolean>
  error?: string
}

export interface TraceSink { record(span: TraceSpan): void }

export class MemoryTraceSink implements TraceSink {
  readonly spans: TraceSpan[] = []
  record(span: TraceSpan): void { this.spans.push({ ...span, attributes: { ...span.attributes } }) }
}

export function startTraceSpan(sink: TraceSink | undefined, name: string, attributes: TraceSpan['attributes'] = {}): { traceId: string; spanId: string; end(status: 'ok' | 'error', error?: unknown): void } {
  const span: TraceSpan = { traceId: randomUUID(), spanId: randomUUID(), name, startedAt: Date.now(), attributes: { ...attributes } }
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    end(status, error) {
      span.endedAt = Date.now()
      span.status = status
      if (error !== undefined) span.error = error instanceof Error ? error.message : String(error)
      sink?.record(span)
    }
  }
}
