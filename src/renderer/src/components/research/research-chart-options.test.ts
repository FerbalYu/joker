import test from 'node:test'
import assert from 'node:assert/strict'
import type { SafeResearchChart } from '../../research-report'
import {
  buildChartOption,
  categoryLabelRotation,
  chartAxisMetadata,
  chartTypeKey,
  formatChartNumber
} from './research-chart-options'

const table = { columns: ['Label', 'Value'], rows: [] }

function optionRecord(chart: SafeResearchChart, reducedMotion = false): Record<string, unknown> {
  return buildChartOption(chart, reducedMotion) as Record<string, unknown>
}

function axisRecord(option: Record<string, unknown>, key: 'xAxis' | 'yAxis'): Record<string, unknown> {
  return option[key] as Record<string, unknown>
}

function firstSeries(option: Record<string, unknown>): Record<string, unknown> {
  return (option.series as Array<Record<string, unknown>>)[0] ?? {}
}

void test('axis metadata remains outside ECharts axis names', () => {
  const chart: SafeResearchChart = {
    type: 'bar',
    title: 'Long chart title',
    xLabel: '煤炭名称与运输批次',
    yLabel: '统计产量（万吨）',
    sourceIds: ['S1'],
    data: [{ label: 'A', value: 2 }],
    table
  }
  const option = optionRecord(chart)

  assert.deepEqual(chartAxisMetadata(chart), { x: chart.xLabel, y: chart.yLabel })
  assert.equal('name' in axisRecord(option, 'xAxis'), false)
  assert.equal('name' in axisRecord(option, 'yAxis'), false)
  assert.equal(chartTypeKey(chart.type), 'research.chart.type.bar')
})

void test('bar options add bounded labels, rounded bars, and styled tooltip', () => {
  const chart: SafeResearchChart = {
    type: 'bar',
    title: 'Counts',
    sourceIds: ['S1'],
    data: [
      { label: 'Verified primary source', value: 1200 },
      { label: 'Independent evidence', value: 2 }
    ],
    table
  }
  const option = optionRecord(chart)
  const series = firstSeries(option)
  const label = series.label as { show?: boolean; formatter?: (params: { value?: unknown }) => string }
  const tooltip = option.tooltip as Record<string, unknown>

  assert.equal(option.animation, true)
  assert.equal(tooltip.renderMode, 'html')
  assert.equal(tooltip.confine, true)
  assert.equal(series.type, 'bar')
  assert.equal(series.barMaxWidth, 52)
  assert.deepEqual((series.itemStyle as Record<string, unknown>).borderRadius, [7, 7, 2, 2])
  assert.equal(label.show, true)
  assert.equal(label.formatter?.({ value: 1200 }).replace(/\D/g, ''), '1200')
})

void test('line, pie, and scatter options preserve their visual hierarchy', () => {
  const line = optionRecord({
    type: 'line',
    title: 'Trend',
    sourceIds: ['S1'],
    data: [{ label: 'One', value: 1 }, { label: 'Two', value: 2 }],
    table
  })
  const pieChart: SafeResearchChart = {
    type: 'pie',
    title: 'Share',
    sourceIds: ['S1'],
    data: [{ label: 'One', value: 1 }, { label: 'Two', value: 2 }],
    table
  }
  const pie = optionRecord(pieChart)
  const scatter = optionRecord({
    type: 'scatter',
    title: 'Relationship',
    xLabel: 'Speed',
    yLabel: 'Cost',
    sourceIds: ['S1'],
    data: [{ x: 1, y: 2, label: 'One' }],
    table: { columns: ['Speed', 'Cost', 'Label'], rows: [] }
  })

  assert.equal(firstSeries(line).smooth, true)
  assert.equal((firstSeries(line).lineStyle as Record<string, unknown>).width, 3)
  assert.deepEqual(firstSeries(pie).radius, ['38%', '70%'])
  assert.equal(firstSeries(pie).padAngle, 2)
  assert.equal((pie.legend as Record<string, unknown>).icon, 'circle')
  assert.equal(firstSeries(scatter).symbolSize, 11)
  assert.equal((firstSeries(scatter).emphasis as Record<string, unknown>).scale, 1.25)
  assert.deepEqual(chartAxisMetadata(pieChart), {})
})

void test('reduced motion and long category labels alter deterministic layout options', () => {
  const labels = Array.from({ length: 9 }, (_, index) => `Category ${index + 1}`)
  const option = optionRecord({
    type: 'bar',
    title: 'Many categories',
    sourceIds: ['S1'],
    data: labels.map((label, index) => ({ label, value: index + 1 })),
    table
  }, true)
  const xAxis = axisRecord(option, 'xAxis')
  const axisLabel = xAxis.axisLabel as Record<string, unknown>

  assert.equal(option.animation, false)
  assert.equal(option.animationDuration, 0)
  assert.equal(categoryLabelRotation(labels), 24)
  assert.equal(categoryLabelRotation(['Short', 'Labels']), 0)
  assert.equal(axisLabel.rotate, 24)
  assert.equal(axisLabel.overflow, 'truncate')
})

void test('number formatting keeps finite values readable and non-numeric values intact', () => {
  assert.equal(formatChartNumber(12.345), '12.35')
  assert.equal(formatChartNumber('not-a-number'), 'not-a-number')
})
