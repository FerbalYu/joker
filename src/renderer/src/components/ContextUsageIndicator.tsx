import { useState } from 'react'
import type { ContextUsage } from '@shared/types'

export default function ContextUsageIndicator({ usage }: { usage: ContextUsage }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const percent = Math.max(0, Math.min(100, usage.percent))
  const radius = 8
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference * (1 - percent / 100)
  const inputLabel = `${formatTokenCount(usage.inputTokens)} / ${formatTokenCount(usage.maxTokens)}`
  const rows = [
    ['消息', usage.messageTokens],
    ['MCP 工具', usage.mcpTokens],
    ['系统工具', usage.toolTokens],
    ['技能', usage.skillTokens],
    ['系统提示词', usage.systemPromptTokens],
    ['其他', usage.otherTokens]
  ] as const

  return (
    <div className="relative shrink-0" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" aria-label={`上下文占用 ${percent}%`} aria-expanded={open} onClick={() => setOpen((value) => !value)} className="relative flex h-7 w-7 items-center justify-center rounded-full text-[10px] text-[var(--color-text-secondary)] transition hover:bg-[var(--color-surface-hover)]">
        <svg viewBox="0 0 22 22" className="h-6 w-6 -rotate-90" aria-hidden="true">
          <circle cx="11" cy="11" r={radius} fill="none" stroke="var(--color-border-light)" strokeWidth="2.5" />
          <circle cx="11" cy="11" r={radius} fill="none" stroke="var(--color-accent)" strokeWidth="2.5" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={dashOffset} />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-[9px] font-medium">{Math.round(percent)}</span>
      </button>
      {open && (
        <div className="absolute bottom-full right-0 z-50 mb-2 w-72 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-[11px] text-[var(--color-text-secondary)] shadow-2xl">
          <div className="mb-2 flex items-start justify-between gap-3"><span className="font-medium text-[var(--color-text-primary)]">上下文容量</span><span className="text-right text-[var(--color-text-primary)]">{inputLabel}（{percent.toFixed(1)}%）</span></div>
          <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-active)]"><div className="h-full rounded-full bg-[var(--color-accent)]" style={{ width: `${percent}%` }} /></div>
          <div className="space-y-1.5">{rows.map(([label, tokens]) => <div key={label} className="flex items-center justify-between gap-3"><span>{label}</span><span className="text-[var(--color-text-primary)]">{formatPercent(tokens, usage.inputTokens)}</span></div>)}</div>
          <div className="mt-3 flex items-center justify-between border-t border-[var(--color-border)] pt-2"><span>平均缓存命中率</span><span className="text-[var(--color-text-primary)]">{usage.cacheHitRate === undefined ? '—' : `${usage.cacheHitRate.toFixed(1)}%`}</span></div>
          <div className="mt-2 text-[10px] text-[var(--color-text-muted)]">分类数据为当前请求的估算值</div>
        </div>
      )}
    </div>
  )
}

function formatTokenCount(value: number): string {
  if (value >= 10000) return `${(value / 10000).toFixed(1)}万`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

function formatPercent(value: number, total: number): string {
  if (!total) return '0.0%'
  return `${Math.max(0, Math.min(100, (value / total) * 100)).toFixed(1)}%`
}
