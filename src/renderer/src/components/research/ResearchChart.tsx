import { useEffect, useMemo, useRef } from 'react'
import { init, use, type EChartsType } from 'echarts/core'
import { BarChart, LineChart, PieChart, ScatterChart } from 'echarts/charts'
import { AriaComponent, GridComponent, LegendComponent, TitleComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { SafeResearchChart } from '../../research-report'
import { useStore } from '../../store'
import { t } from '../../i18n'
import { buildChartOption, chartAxisMetadata, chartTypeKey } from './research-chart-options'

use([CanvasRenderer, BarChart, LineChart, PieChart, ScatterChart, GridComponent, LegendComponent, TooltipComponent, TitleComponent, AriaComponent])

export default function ResearchChart({ chart }: { chart: SafeResearchChart }): React.JSX.Element {
  const language = useStore((state) => state.language)
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<EChartsType | null>(null)
  const reducedMotion = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, [])
  const option = useMemo(() => buildChartOption(chart, reducedMotion), [chart, reducedMotion])
  const axes = useMemo(() => chartAxisMetadata(chart), [chart])

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
    <section data-research-chart className="overflow-hidden rounded-xl bg-[linear-gradient(145deg,var(--color-bg),color-mix(in_srgb,var(--color-surface)_82%,transparent))] p-4 shadow-[inset_0_0_0_1px_var(--color-border),0_12px_32px_rgba(0,0,0,0.14)]">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h4 data-chart-title className="text-sm font-semibold leading-5 text-[var(--color-text-primary)] [text-wrap:pretty]">{chart.title}</h4>
          {(axes.x || axes.y) && (
            <dl data-chart-axis-meta className="mt-2 grid min-w-0 gap-1.5 text-[10px] leading-4 text-[var(--color-text-muted)] sm:flex sm:flex-wrap sm:gap-2">
              {axes.x && <div className="flex min-w-0 max-w-full items-start gap-1.5 rounded-lg bg-[var(--color-surface-active)] px-2.5 py-1.5 shadow-[inset_0_0_0_1px_var(--color-border)]"><dt className="shrink-0 font-medium uppercase tracking-wide text-[var(--color-accent)]">{t(language, 'research.chart.xAxis')}</dt><dd className="min-w-0 break-words text-[var(--color-text-secondary)]">{axes.x}</dd></div>}
              {axes.y && <div className="flex min-w-0 max-w-full items-start gap-1.5 rounded-lg bg-[var(--color-surface-active)] px-2.5 py-1.5 shadow-[inset_0_0_0_1px_var(--color-border)]"><dt className="shrink-0 font-medium uppercase tracking-wide text-[var(--color-accent)]">{t(language, 'research.chart.yAxis')}</dt><dd className="min-w-0 break-words text-[var(--color-text-secondary)]">{axes.y}</dd></div>}
            </dl>
          )}
        </div>
        <span className="shrink-0 rounded-full bg-[var(--color-accent)]/10 px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider text-[var(--color-accent)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_28%,transparent)]">{t(language, chartTypeKey(chart.type))}</span>
      </header>
      <div ref={containerRef} role="img" aria-label={t(language, 'research.chart.aria', { title: chart.title })} className="mt-3 h-[clamp(18rem,42vw,24rem)] min-h-72 w-full" />
      <details className="group mt-3 text-xs text-[var(--color-text-secondary)]">
        <summary className="flex min-h-10 cursor-pointer select-none items-center rounded-lg px-2.5 font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-surface-active)]">{t(language, 'research.chart.data')}</summary>
        <div className="mt-2 max-w-full overflow-x-auto rounded-lg bg-[var(--color-bg)] shadow-[inset_0_0_0_1px_var(--color-border)]">
          <table className="min-w-full border-collapse text-left">
            <thead><tr>{chart.table.columns.map((column) => <th key={column} className="whitespace-nowrap border-b border-[var(--color-border)] bg-[var(--color-surface-active)] px-3 py-2.5 font-medium text-[var(--color-text-primary)]">{column}</th>)}</tr></thead>
            <tbody>{chart.table.rows.map((row, rowIndex) => <tr key={rowIndex} className="odd:bg-white/[0.015] hover:bg-[var(--color-surface-active)]/70">{row.map((value, columnIndex) => <td key={columnIndex} className="whitespace-nowrap border-b border-[var(--color-border)]/50 px-3 py-2.5 tabular-nums last:border-b-0">{value}</td>)}</tr>)}</tbody>
          </table>
        </div>
      </details>
      <p className="mt-2 text-[10px] text-[var(--color-text-muted)]">{t(language, 'research.chart.sources')}: {chart.sourceIds.map((id) => `[${id}]`).join(' ')}</p>
    </section>
  )
}
