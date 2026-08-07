import { join } from 'node:path'

import { readJsonWithBackupStrict, updateJsonWithBackupStrict } from './atomic-json'
import { getJokerHomeDir } from './paths'
import {
  createEmptyGate5Metrics,
  Gate5MetricIdSchema,
  parseGate5Metrics,
  type Gate5MetricId,
  type Gate5MetricValue,
  type Gate5Metrics
} from '../../shared/gate5-metrics'

export const GATE5_METRICS_RELATIVE_PATH = join('.joker', 'metrics', 'gate5-metrics.json')

export function getGate5MetricsPath(jokerHome = getJokerHomeDir()): string {
  return join(jokerHome, GATE5_METRICS_RELATIVE_PATH)
}

export function readGate5Metrics(jokerHome = getJokerHomeDir()): Gate5Metrics {
  return readJsonWithBackupStrict(getGate5MetricsPath(jokerHome), parseGate5Metrics) ?? createEmptyGate5Metrics()
}

export function recordGate5Metric(
  metric: Gate5MetricId,
  value = 1,
  observedAt = Date.now(),
  jokerHome = getJokerHomeDir()
): Gate5Metrics {
  if (!Gate5MetricIdSchema.safeParse(metric).success) throw new Error(`Unknown Gate 5 metric: ${metric}`)
  if (!Number.isFinite(value) || value < 0) throw new Error('Gate 5 metric value must be finite and non-negative')
  return updateJsonWithBackupStrict(
    getGate5MetricsPath(jokerHome),
    parseGate5Metrics,
    () => createEmptyGate5Metrics(observedAt),
    (current) => {
      const previous = current.metrics[metric] as Gate5MetricValue
      return {
        ...current,
        generatedAt: observedAt,
        revision: current.revision + 1,
        metrics: {
          ...current.metrics,
          [metric]: {
            count: previous.count + 1,
            total: previous.total + value,
            lastObservedAt: observedAt
          }
        }
      }
    }
  )
}

export function recordGate5Metrics(
  values: Partial<Record<Gate5MetricId, number>>,
  observedAt = Date.now(),
  jokerHome = getJokerHomeDir()
): Gate5Metrics {
  return Object.entries(values).reduce(
    (_current, [metric, value]) => recordGate5Metric(metric as Gate5MetricId, value, observedAt, jokerHome),
    readGate5Metrics(jokerHome)
  )
}
