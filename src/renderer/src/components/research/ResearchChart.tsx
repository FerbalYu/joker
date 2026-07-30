import { useEffect, useMemo, useRef } from 'react'
import { init, use, type EChartsType } from 'echarts/core'
import { BarChart, LineChart, PieChart, ScatterChart } from 'echarts/charts'
import { AriaComponent, GridComponent, LegendComponent, TitleComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsOption } from 'echarts'
import type { SafeResearchChart } from '../../research-report'
import { useStore } from '../../store'
import { t } from '../../i18n'

use([CanvasRenderer, BarChart, LineChart, PieChart, ScatterChart, GridComponent, LegendComponent, TooltipComponent, TitleComponent, AriaComponent])

const COLORS = ['#32f08c', '#57a6ff', '#ffc857', '#ff7a90', '#a88cff', '#55d6c2']

export default function ResearchChart({ chart }: { chart: SafeResearchChart }): React.JSX.Element {
  const language = useStore((state) => state.language)
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<EChartsType | null>(null)
  const reducedMotion = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, [])
  const option = useMemo(() => buildChartOption(chart, reducedMotion), [chart, reducedMotion])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const instance = init(container, undefined, { renderer: 'canvas' })
    chartRef.current = instance
    instance.setOption(option, true)
    const observer = new ResizeObserver(() => instance.resize())
    observer.observe(container)
    return () => {
      observer.disconnect()
      instance.dispose()
      chartRef.current = null
    }
  }, [option])

  return (
    <section className="rounded-xl bg-[var(--color-bg)] p-4 shadow-[inset_0_0_0_1px_var(--color-border)]">
      <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">{chart.title}</h4>
      <div ref={containerRef} role="img" aria-label={t(language, 'research.chart.aria', { title: chart.title })} className="mt-2 h-80 min-h-64 w-full" />
      <details className="mt-3 text-xs text-[var(--color-text-secondary)]">
        <summary className="cursor-pointer select-none font-medium text-[var(--color-accent)]">{t(language, 'research.chart.data')}</summary>
        <div className="mt-2 max-w-full overflow-x-auto rounded-lg border border-[var(--color-border)]">
          <table className="min-w-full border-collapse text-left">
            <thead><tr>{chart.table.columns.map((column) => <th key={column} className="whitespace-nowrap border-b border-[var(--color-border)] bg-[var(--color-surface-active)] px-3 py-2 font-medium">{column}</th>)}</tr></thead>
            <tbody>{chart.table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((value, columnIndex) => <td key={columnIndex} className="whitespace-nowrap border-b border-[var(--color-border)]/50 px-3 py-2 tabular-nums last:border-b-0">{value}</td>)}</tr>)}</tbody>
          </table>
        </div>
      </details>
      <p className="mt-2 text-[10px] text-[var(--color-text-muted)]">{t(language, 'research.chart.sources')}: {chart.sourceIds.map((id) => `[${id}]`).join(' ')}</p>
    </section>
  )
}

export function buildChartOption(chart: SafeResearchChart, reducedMotion: boolean): EChartsOption {
  const common: EChartsOption = {
    animation: !reducedMotion,
    color: COLORS,
    backgroundColor: 'transparent',
    aria: { enabled: true },
    textStyle: { color: '#a6aab5', fontFamily: '-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif' },
    title: { show: false },
    tooltip: { trigger: chart.type === 'pie' ? 'item' : 'axis', renderMode: 'richText' },
    legend: chart.type === 'pie' ? { bottom: 0, textStyle: { color: '#a6aab5' } } : undefined
  }
  if (chart.type === 'pie') {
    return { ...common, series: [{ type: 'pie', radius: ['35%', '68%'], center: ['50%', '45%'], data: chart.data.map((point) => ({ name: point.label, value: point.value })), label: { color: '#f5f9fe' } }] }
  }
  if (chart.type === 'scatter') {
    return {
      ...common,
      grid: { left: 48, right: 20, top: 18, bottom: 48, containLabel: true },
      xAxis: axis('value', chart.xLabel),
      yAxis: axis('value', chart.yLabel),
      series: [{ type: 'scatter', symbolSize: 10, data: chart.data.map((point) => ({ value: [point.x, point.y], name: point.label })) }]
    }
  }
  return {
    ...common,
    grid: { left: 48, right: 20, top: 18, bottom: 56, containLabel: true },
    xAxis: axis('category', chart.xLabel, chart.data.map((point) => point.label)),
    yAxis: axis('value', chart.yLabel),
    series: [{ type: chart.type, data: chart.data.map((point) => point.value), smooth: chart.type === 'line', areaStyle: chart.type === 'line' ? { opacity: 0.08 } : undefined }]
  }
}

function axis(type: 'category' | 'value', name?: string, data?: string[]): Record<string, unknown> {
  return {
    type,
    name,
    data,
    nameTextStyle: { color: '#6b6f7a' },
    axisLine: { lineStyle: { color: 'rgba(237,239,242,0.18)' } },
    axisTick: { lineStyle: { color: 'rgba(237,239,242,0.18)' } },
    axisLabel: { color: '#a6aab5', hideOverlap: true },
    splitLine: { lineStyle: { color: 'rgba(237,239,242,0.08)' } }
  }
}
