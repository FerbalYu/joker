import { Bot, CheckCircle2, ChevronDown, CircleSlash2, Clock3, Loader2, Search, XCircle } from 'lucide-react'
import type { SubagentActivity, SubagentStatus, SubagentToolActivity } from '@shared/types'
import type { Language } from '../i18n'
import { t, toolLabel } from '../i18n'
import { formatElapsedDuration } from '../run-activity'

interface Props {
  activities: SubagentActivity[]
  language: Language
  now: number
}

export default function SubagentActivityList({ activities, language, now }: Props): React.JSX.Element | null {
  if (activities.length === 0) return null
  return (
    <div className="space-y-2" data-subagent-activity-list>
      {activities.map((activity) => <SubagentCard key={activity.id} activity={activity} language={language} now={now} />)}
    </div>
  )
}

function SubagentCard({ activity, language, now }: { activity: SubagentActivity; language: Language; now: number }): React.JSX.Element {
  const active = activity.status === 'queued' || activity.status === 'running'
  const durationEnd = activity.completedAt ?? (active ? now : activity.updatedAt)
  const duration = activity.startedAt === undefined ? null : formatElapsedDuration(Math.max(0, durationEnd - activity.startedAt))
  const StatusIcon = statusIcon(activity.status)
  return (
    <details open={active} data-subagent-id={activity.id} data-subagent-status={activity.status} className={`group overflow-hidden rounded-lg border bg-[var(--color-bg)] ${active ? 'border-[var(--color-accent)]/60' : activity.status === 'failed' ? 'border-red-700/80' : 'border-[var(--color-border)]'}`}>
      <summary className="flex cursor-pointer list-none items-start gap-2 px-2.5 py-2.5 hover:bg-[var(--color-surface-hover)]">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--color-surface-active)] text-[var(--color-text-secondary)]">
          {active ? <Loader2 size={14} className="animate-spin text-[var(--color-accent)]" /> : <Bot size={14} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-[var(--color-text-primary)]">{t(language, 'subagent.title')}</span>
            <span className={`flex shrink-0 items-center gap-1 text-[10px] ${statusClass(activity.status)}`}><StatusIcon size={12} />{t(language, `subagent.status.${activity.status}`)}</span>
          </span>
          <span className="mt-0.5 block line-clamp-2 text-[11px] leading-relaxed text-[var(--color-text-secondary)]">{activity.task}</span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[9px] text-[var(--color-text-muted)]">
            <span>{t(language, `subagent.phase.${activity.phase}`)}</span>
            {activity.currentStep > 0 && <span>{t(language, 'subagent.step', { current: activity.currentStep, max: activity.maxSteps })}</span>}
            {duration && <span className="flex items-center gap-1 font-mono tabular-nums"><Clock3 size={10} />{duration}</span>}
          </span>
        </span>
        <ChevronDown size={14} className="mt-1 shrink-0 text-[var(--color-text-muted)] transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-3 border-t border-[var(--color-border)]/70 px-2.5 py-2.5">
        <p className="text-[9px] leading-relaxed text-[var(--color-text-muted)]">{t(language, 'subagent.observableNotice')}</p>
        {activity.tools.length === 0
          ? <p className="rounded-md bg-[var(--color-surface)] px-2 py-2 text-[10px] text-[var(--color-text-muted)]">{t(language, active ? 'subagent.noToolsYet' : 'subagent.noTools')}</p>
          : <div className="space-y-1.5">{activity.tools.map((tool) => <SubagentToolRow key={tool.id} tool={tool} language={language} />)}</div>}
        {activity.outputPreview && <div><p className="mb-1 text-[9px] uppercase tracking-wide text-[var(--color-text-muted)]">{t(language, 'subagent.result')}</p><p className="max-h-36 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-[var(--color-surface)] p-2 text-[10px] leading-relaxed text-[var(--color-text-secondary)]">{activity.outputPreview}</p></div>}
        {activity.error && <p className="break-words rounded-md bg-red-950/30 p-2 text-[10px] text-red-300">{activity.error}</p>}
        {activity.usage && <p className="font-mono text-[9px] tabular-nums text-[var(--color-text-muted)]">{activity.usage.totalTokens === undefined
          ? t(language, 'subagent.usageStepsOnly', { steps: activity.usage.stepCount ?? activity.currentStep })
          : t(language, 'subagent.usage', { tokens: activity.usage.totalTokens.toLocaleString(), steps: activity.usage.stepCount ?? activity.currentStep })}</p>}
      </div>
    </details>
  )
}

function SubagentToolRow({ tool, language }: { tool: SubagentToolActivity; language: Language }): React.JSX.Element {
  const Icon = tool.status === 'running' ? Loader2 : tool.status === 'done' ? CheckCircle2 : tool.status === 'denied' ? CircleSlash2 : XCircle
  return <div data-subagent-tool={tool.toolName} className="flex items-start gap-2 rounded-md bg-[var(--color-surface)] px-2 py-1.5">
    <Icon size={12} className={`mt-0.5 shrink-0 ${tool.status === 'running' ? 'animate-spin text-[var(--color-accent)]' : tool.status === 'done' ? 'text-emerald-400' : tool.status === 'denied' ? 'text-amber-400' : 'text-red-400'}`} />
    <span className="min-w-0 flex-1"><span className="block text-[10px] font-medium text-[var(--color-text-primary)]">{toolLabel(language, tool.toolName)}</span>{tool.summary && <span className="block truncate font-mono text-[9px] text-[var(--color-text-muted)]" title={tool.summary}>{tool.summary}</span>}{tool.error && <span className="block break-words text-[9px] text-red-300">{tool.error}</span>}</span>
    {tool.durationMs !== undefined && <span className="shrink-0 font-mono text-[9px] tabular-nums text-[var(--color-text-muted)]">{tool.durationMs}ms</span>}
  </div>
}

function statusIcon(status: SubagentStatus): React.ElementType {
  return status === 'completed' ? CheckCircle2 : status === 'failed' ? XCircle : status === 'cancelled' ? CircleSlash2 : status === 'queued' ? Clock3 : Search
}

function statusClass(status: SubagentStatus): string {
  return status === 'completed' ? 'text-emerald-400' : status === 'failed' ? 'text-red-400' : status === 'cancelled' ? 'text-amber-400' : 'text-[var(--color-accent)]'
}
