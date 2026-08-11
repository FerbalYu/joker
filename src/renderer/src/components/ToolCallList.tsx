import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, Wrench } from 'lucide-react'
import type { ToolCallInfo } from '@shared/types'
import { useStore } from '../store'
import { t, toolLabel } from '../i18n'
import ToolCard, { getToolForgeSummary, ToolForgeSummary } from './ToolCard'
import { visibleToolCards } from '../tool-visibility'

interface Props {
  toolCalls: ToolCallInfo[]
}

export default function ToolCallList({ toolCalls }: Props): React.JSX.Element | null {
  const language = useStore((s) => s.language)
  const visibleToolCalls = useMemo(() => visibleToolCards(toolCalls), [toolCalls])
  const hasRunning = visibleToolCalls.some((toolCall) => toolCall.status === 'running')
  const [expanded, setExpanded] = useState(false)

  const summary = useMemo(() => buildSummary(visibleToolCalls, language), [language, visibleToolCalls])
  const forgeSummaries = useMemo(() => {
    const byTool = new Map<string, { key: string; summary: NonNullable<ReturnType<typeof getToolForgeSummary>> }>()
    toolCalls.forEach((toolCall, index) => {
      const forgeSummary = getToolForgeSummary(toolCall, language)
      if (!forgeSummary) return
      const key = forgeSummary.toolId ?? toolCall.toolCallId ?? `${toolCall.toolName}-${index}`
      byTool.set(key, { key, summary: forgeSummary })
    })
    return [...byTool.values()]
  }, [language, toolCalls])

  if (toolCalls.length === 0) return null

  if (visibleToolCalls.length === 0) {
    return forgeSummaries.length > 0 ? (
      <div className="w-full max-w-[640px] space-y-1.5">
        {forgeSummaries.map((item) => <ToolForgeSummary key={item.key} summary={item.summary} language={language} />)}
      </div>
    ) : null
  }

  if (visibleToolCalls.length === 1) {
    return (
      <div className="w-full max-w-[640px] space-y-1.5">
        <ToolCard toolCall={visibleToolCalls[0]} />
        {forgeSummaries.map((item) => <ToolForgeSummary key={item.key} summary={item.summary} language={language} />)}
      </div>
    )
  }

  const errorCount = visibleToolCalls.filter((toolCall) => toolCall.status === 'error').length
  const doneCount = visibleToolCalls.filter((toolCall) => toolCall.status === 'done').length

  return (
    <div
      data-tool-call-group
      className={`w-full max-w-[640px] overflow-hidden rounded-lg border bg-[var(--color-surface)] shadow-[0_8px_24px_rgba(0,0,0,0.12)] ${
        hasRunning
          ? 'border-[var(--color-accent)] shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-accent)_35%,transparent),0_8px_24px_rgba(0,0,0,0.16)]'
          : errorCount > 0
            ? 'border-red-700'
            : 'border-[var(--color-border)]'
      }`}
    >
      <button
        data-tool-call-group-toggle
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex min-h-6 w-full items-center gap-2 px-2 py-1 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--color-bg)] text-[var(--color-text-secondary)]">
          {hasRunning ? <Loader2 size={14} className="animate-spin text-[var(--color-accent)]" /> : <Wrench size={14} />}
        </span>
        <span className="shrink-0 whitespace-nowrap rounded-md bg-[var(--color-accent)]/10 px-1.5 py-0.5 text-[12px] font-medium leading-none text-[var(--color-text-primary)]">
          {t(language, 'tool.group.title', { count: visibleToolCalls.length })}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-muted)]" title={summary}>
          {summary}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2 text-[10px] text-[var(--color-text-muted)]">
          {hasRunning
            ? t(language, 'tool.group.running')
            : errorCount > 0
              ? t(language, 'tool.group.errors', { count: errorCount })
              : t(language, 'tool.group.done', { count: doneCount })}
          {expanded ? (
            <ChevronDown size={15} className="text-[var(--color-text-muted)]" />
          ) : (
            <ChevronRight size={15} className="text-[var(--color-text-muted)]" />
          )}
        </span>
      </button>

      {forgeSummaries.length > 0 && (
        <div data-toolforge-group-evidence className="space-y-1.5 border-t border-[var(--color-border)]/70 p-1.5">
          {forgeSummaries.map((item) => (
            <ToolForgeSummary key={item.key} summary={item.summary} language={language} />
          ))}
        </div>
      )}

      {expanded && (
        <div className="space-y-1.5 border-t border-[var(--color-border)]/70 p-1.5">
          {visibleToolCalls.map((toolCall, index) => (
            <ToolCard
              key={toolCall.toolCallId ?? `${toolCall.toolName}-${index}`}
              toolCall={toolCall}
              showForgeSummary={false}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function buildSummary(toolCalls: ToolCallInfo[], language: import('../i18n').Language): string {
  const counts = new Map<string, number>()
  for (const toolCall of toolCalls) {
    const label = toolLabel(language, toolCall.toolName)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([label, count]) => (count > 1 ? `${label} ×${count}` : label))
    .join(' · ')
}
