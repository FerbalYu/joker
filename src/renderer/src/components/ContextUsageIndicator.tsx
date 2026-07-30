import { useState } from 'react'
import type { ContextUsage } from '@shared/types'
import { useStore } from '../store'
import { t } from '../i18n'
import { contextOptimizationView } from '../context-optimization-ui'

export default function ContextUsageIndicator({ usage }: { usage: ContextUsage }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const language = useStore((state) => state.language)
  const percent = Math.max(0, Math.min(100, usage.percent))
  const radius = 8
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference * (1 - percent / 100)
  const inputLabel = `${formatTokenCount(usage.inputTokens, language)} / ${formatTokenCount(usage.maxTokens, language)}`
  const rows = [
    [language === 'zh' ? '消息' : 'Messages', usage.messageTokens],
    [language === 'zh' ? 'MCP 工具' : 'MCP tools', usage.mcpTokens],
    [language === 'zh' ? '系统消息' : 'System messages', usage.systemTokens],
    [language === 'zh' ? '系统工具' : 'System tools', usage.toolTokens],
    [language === 'zh' ? '技能' : 'Skills', usage.skillTokens],
    [language === 'zh' ? '系统提示词' : 'Instructions', usage.systemPromptTokens],
    [language === 'zh' ? '其他' : 'Other', usage.otherTokens]
  ] as const
  const sourceLabel = t(language, usage.source === 'provider' ? 'detail.providerMeasured' : 'detail.localEstimate')
  const optimization = contextOptimizationView(usage)
  const latestTransform = optimization?.latestTransform

  return (
    <div className="relative shrink-0" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" aria-label={`${t(language, 'detail.context')} ${percent}%`} aria-expanded={open} onClick={() => setOpen((value) => !value)} className="relative flex h-7 w-7 items-center justify-center rounded-full text-[10px] text-[var(--color-text-secondary)] transition hover:bg-[var(--color-surface-hover)]">
        <svg viewBox="0 0 22 22" className="h-6 w-6 -rotate-90" aria-hidden="true">
          <circle cx="11" cy="11" r={radius} fill="none" stroke="var(--color-border-light)" strokeWidth="2.5" />
          <circle cx="11" cy="11" r={radius} fill="none" stroke="var(--color-accent)" strokeWidth="2.5" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={dashOffset} />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-[9px] font-medium">{Math.round(percent)}</span>
      </button>
      {open && (
        <div className="absolute bottom-full right-0 z-50 mb-2 w-80 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-[11px] text-[var(--color-text-secondary)] shadow-2xl">
          <div className="mb-2 flex items-start justify-between gap-3"><span className="font-medium text-[var(--color-text-primary)]">{t(language, 'detail.context')}</span><span className="text-right text-[var(--color-text-primary)]">{inputLabel}（{percent.toFixed(1)}%）</span></div>
          <div className="mb-2 flex flex-wrap gap-1.5 text-[10px]">
            <span className="rounded bg-[var(--color-surface-active)] px-1.5 py-0.5">{sourceLabel}</span>
            {usage.stepNumber !== undefined && <span className="rounded bg-[var(--color-surface-active)] px-1.5 py-0.5">{t(language, 'detail.step', { count: usage.stepNumber })}</span>}
            {(usage.compressionCount ?? 0) > 0 && <span className="rounded bg-[var(--color-surface-active)] px-1.5 py-0.5">{t(language, 'detail.compressions', { count: usage.compressionCount ?? 0 })}</span>}
            {optimization?.mode && <span className="rounded bg-[var(--color-surface-active)] px-1.5 py-0.5">{t(language, 'context.modeValue', { mode: t(language, `context.mode.${optimization.mode}`) })}</span>}
            {optimization?.policyVersion && <span className="rounded bg-[var(--color-surface-active)] px-1.5 py-0.5">{t(language, 'context.policyValue', { policy: optimization.policyVersion })}</span>}
          </div>
          <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-active)]"><div className="h-full rounded-full bg-[var(--color-accent)]" style={{ width: `${percent}%` }} /></div>
          <div className="space-y-1.5">{rows.map(([label, tokens]) => <div key={label} className="flex items-center justify-between gap-3"><span>{label}</span><span className="text-[var(--color-text-primary)]">{formatPercent(tokens, usage.inputTokens)}</span></div>)}</div>
          <div className="mt-3 flex items-center justify-between border-t border-[var(--color-border)] pt-2"><span>{language === 'zh' ? '当前缓存命中率' : 'Current cache hit rate'}</span><span className="text-[var(--color-text-primary)]">{usage.cacheHitRate === undefined ? '—' : `${usage.cacheHitRate.toFixed(1)}%`}</span></div>
          {latestTransform && <div className="mt-3 space-y-1.5 border-t border-[var(--color-border)] pt-2">
            <MetricRow label={t(language, 'context.latestTransform')} value={`${latestTransform.sourceType ? `${latestTransform.sourceType} · ` : ''}${latestTransform.transform}`} />
            <MetricRow label={t(language, 'context.transformTokens')} value={`${formatTokenCount(latestTransform.beforeTokens, language)} → ${formatTokenCount(latestTransform.afterTokens, language)}`} mono />
            <MetricRow label={t(language, 'context.retrievable')} value={t(language, latestTransform.retrievable ? 'context.yes' : 'context.no')} />
          </div>}
          {optimization && <div className="mt-3 space-y-1.5 border-t border-[var(--color-border)] pt-2">
            <MetricRow label={t(language, 'context.summaryCost')} value={`${formatTokenCount(optimization.summaryInputTokens, language)} + ${formatTokenCount(optimization.summaryOutputTokens, language)}`} mono />
            <MetricRow label={t(language, 'context.estimatedNetSaved')} value={optimization.estimatedNetSavedTokens === undefined ? '—' : formatSignedTokenCount(optimization.estimatedNetSavedTokens, language)} mono />
            <MetricRow label={t(language, 'context.retrievalCount')} value={optimization.retrievalFailureCount > 0 ? `${optimization.retrievalCount} (${t(language, 'context.retrievalFailures', { count: optimization.retrievalFailureCount })})` : String(optimization.retrievalCount)} />
          </div>}
          {optimization?.error && <div className="mt-2 break-words text-[10px] text-amber-400">{t(language, 'context.errorValue', { error: optimization.error })}</div>}
          <div className="mt-2 text-[10px] text-[var(--color-text-muted)]">{usage.source === 'provider'
            ? (language === 'zh' ? '总输入由服务商实测，分类与优化节省为本地估算。' : 'Total input is provider measured; category shares and optimization savings are local estimates.')
            : (language === 'zh' ? '服务商未报告当前用量，全部数据为本地估算。' : 'The provider did not report current usage; all values are local estimates.')}</div>
        </div>
      )}
    </div>
  )
}

function MetricRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): React.JSX.Element {
  return <div className="flex items-start justify-between gap-3"><span>{label}</span><span className={`max-w-[60%] break-words text-right text-[var(--color-text-primary)] ${mono ? 'font-mono' : ''}`}>{value}</span></div>
}

function formatTokenCount(value: number, language: 'zh' | 'en'): string {
  if (language === 'zh' && value >= 10000) return `${(value / 10000).toFixed(1)}万`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

function formatSignedTokenCount(value: number, language: 'zh' | 'en'): string {
  return `${value > 0 ? '+' : ''}${formatTokenCount(value, language)}`
}

function formatPercent(value: number, total: number): string {
  if (!total) return '0.0%'
  return `${Math.max(0, Math.min(100, (value / total) * 100)).toFixed(1)}%`
}
