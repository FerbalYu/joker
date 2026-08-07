import { z } from 'zod'

export const GATE5_METRIC_IDS = [
  'capability-gap-detected',
  'tool-search-hit',
  'forge-job-created',
  'forge-job-completed',
  'forge-job-failed',
  'forge-job-cancelled',
  'forge-job-interrupted',
  'validation-first-pass',
  'validation-repair-rounds',
  'manufacturing-duration-ms',
  'permission-boundary-blocked',
  'permission-isolation-triggered',
  'manual-approval-requested',
  'first-call-succeeded',
  'continuation-succeeded',
  'continuation-duplicate-blocked',
  'continuation-recovered',
  'tool-call-succeeded',
  'tool-call-failed',
  'tool-call-timeout',
  'tool-call-crashed',
  'version-rollback',
  'stable-version-retained',
  'tool-modified',
  'tool-disabled',
  'tool-deleted',
  'tool-exported',
  'schema-context-token-increment'
] as const

export type Gate5MetricId = (typeof GATE5_METRIC_IDS)[number]

export const Gate5MetricIdSchema = z.enum(GATE5_METRIC_IDS)

export const Gate5MetricValueSchema = z.object({
  count: z.number().int().nonnegative(),
  total: z.number().finite().nonnegative(),
  lastObservedAt: z.number().int().nonnegative().optional()
}).strict()

export const Gate5MetricsSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  metrics: z.object(Object.fromEntries(GATE5_METRIC_IDS.map((id) => [id, Gate5MetricValueSchema])) as Record<Gate5MetricId, typeof Gate5MetricValueSchema>).strict()
}).strict()

export type Gate5MetricValue = z.infer<typeof Gate5MetricValueSchema>
export type Gate5Metrics = z.infer<typeof Gate5MetricsSchema>

export function createEmptyGate5Metrics(generatedAt = Date.now()): Gate5Metrics {
  return Gate5MetricsSchema.parse({
    schemaVersion: 1,
    generatedAt,
    revision: 0,
    metrics: Object.fromEntries(GATE5_METRIC_IDS.map((id) => [id, { count: 0, total: 0 }]))
  })
}

export function parseGate5Metrics(value: unknown): Gate5Metrics {
  return Gate5MetricsSchema.parse(value)
}
