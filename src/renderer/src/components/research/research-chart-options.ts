import type { EChartsOption } from 'echarts'
import type { SafeResearchChart } from '../../research-report'

const COLORS = ['#32f08c', '#57a6ff', '#ffc857', '#ff7a90', '#a88cff', '#55d6c2']

export type ChartAxisMetadata = {
  x?: string
  y?: string
}

export function chartAxisMetadata(chart: SafeResearchChart): ChartAxisMetadata {
  if (chart.type === 'pie') return {}
  return {
    x: chart.xLabel,
    y: chart.yLabel
  }
}

export function chartTypeKey(type: SafeResearchChart['type']): string {
  return `research.chart.type.${type}`
}

export function buildChartOption(chart: SafeResearchChart, reducedMotion: boolean): EChartsOption {
  const common: EChartsOption = {
    animation: !reducedMotion,
    animationDuration: reducedMotion ? 0 : 500,
    animationEasing: 'cubicOut',
    color: COLORS,
    backgroundColor: 'transparent',
    aria: { enabled: true },
    textStyle: { color: '#a6aab5', fontFamily: '-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif' },
    title: { show: false },
    tooltip: {
      trigger: chart.type === 'pie' ? 'item' : 'axis',
      renderMode: 'html',
      confine: true,
      backgroundColor: 'rgba(18, 20, 25, 0.96)',
      borderColor: 'rgba(237, 239, 242, 0.14)',
      borderWidth: 1,
      padding: [9, 11],
      textStyle: { color: '#f5f9fe', fontSize: 12 },
      extraCssText: 'border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.32);backdrop-filter:blur(8px);'
    },
    legend: chart.type === 'pie' ? {
      bottom: 0,
      icon: 'circle',
      itemWidth: 8,
      itemHeight: 8,
      itemGap: 16,
      textStyle: { color: '#a6aab5', fontSize: 11 }
    } : undefined
  }
  if (chart.type === 'pie') {
    return {
      ...common,
      series: [{
        type: 'pie',
        radius: ['38%', '70%'],
        center: ['50%', '43%'],
        padAngle: 2,
        itemStyle: { borderColor: '#101216', borderWidth: 2, borderRadius: 5 },
        data: chart.data.map((point) => ({ name: point.label, value: point.value })),
        label: { color: '#f5f9fe', formatter: '{b}\n{d}%', lineHeight: 17 },
        labelLine: { lineStyle: { color: 'rgba(237,239,242,0.28)' } }
      }]
    }
  }
  if (chart.type === 'scatter') {
    return {
      ...common,
      grid: chartGrid(18, 28),
      xAxis: axis('value'),
      yAxis: axis('value'),
      series: [{
        type: 'scatter',
        symbolSize: 11,
        data: chart.data.map((point) => ({ value: [point.x, point.y], name: point.label })),
        itemStyle: { shadowBlur: 14, shadowColor: 'rgba(50,240,140,0.28)' },
        emphasis: { scale: 1.25 }
      }]
    }
  }
  const categoryLabels = chart.data.map((point) => point.label)
  const rotate = categoryLabelRotation(categoryLabels)
  return {
    ...common,
    grid: chartGrid(18, rotate ? 56 : 38),
    xAxis: axis('category', categoryLabels, rotate),
    yAxis: axis('value'),
    series: [{
      type: chart.type,
      data: chart.data.map((point) => point.value),
      smooth: chart.type === 'line',
      symbol: chart.type === 'line' ? 'circle' : undefined,
      symbolSize: chart.type === 'line' ? 7 : undefined,
      showSymbol: chart.type === 'line',
      lineStyle: chart.type === 'line' ? { width: 3, shadowBlur: 12, shadowColor: 'rgba(50,240,140,0.16)' } : undefined,
      areaStyle: chart.type === 'line' ? { opacity: 0.1 } : undefined,
      itemStyle: chart.type === 'bar'
        ? { borderRadius: [7, 7, 2, 2], shadowBlur: 12, shadowColor: 'rgba(50,240,140,0.12)' }
        : undefined,
      barMaxWidth: chart.type === 'bar' ? 52 : undefined,
      label: chart.type === 'bar'
        ? { show: chart.data.length <= 12, position: 'top', color: '#d8dde7', fontSize: 10, formatter: ({ value }: { value?: unknown }) => formatChartNumber(value) }
        : undefined,
      emphasis: { focus: 'series' }
    }]
  }
}

function chartGrid(top: number, bottom: number): NonNullable<EChartsOption['grid']> {
  return { left: 16, right: 16, top, bottom, containLabel: true }
}

export function categoryLabelRotation(labels: string[]): number {
  const longest = labels.reduce((max, label) => Math.max(max, [...label].length), 0)
  return labels.length > 8 || longest > 12 ? 24 : 0
}

function axis(type: 'category' | 'value', data?: string[], rotate = 0): Record<string, unknown> {
  return {
    type,
    data,
    axisLine: { lineStyle: { color: 'rgba(237,239,242,0.16)' } },
    axisTick: { show: false },
    axisLabel: {
      color: '#a6aab5',
      hideOverlap: true,
      interval: type === 'category' ? 0 : undefined,
      rotate,
      margin: 12,
      width: type === 'category' ? 92 : undefined,
      overflow: type === 'category' ? 'truncate' : undefined,
      formatter: type === 'value' ? (value: unknown) => formatChartNumber(value) : undefined
    },
    splitLine: { lineStyle: { color: 'rgba(237,239,242,0.065)' } },
    splitArea: { show: false }
  }
}

export function formatChartNumber(value: unknown): string {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return String(value ?? '')
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(numeric)
}
