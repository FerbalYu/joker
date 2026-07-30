import { useEffect, useState } from 'react'
import { PanelRightClose, PanelRightOpen, ShieldAlert, Circle, CircleCheck, CircleDot } from 'lucide-react'
import { useStore } from '../store'
import { t } from '../i18n'
import ApprovalPanel from './ApprovalPanel'
import ToolCallList from './ToolCallList'
import { latestTodoState } from '../detail-todos'
import { visibleChatTools } from '../tool-visibility'
import { deriveResearchProgress } from '../research-progress'
import { contextOptimizationView } from '../context-optimization-ui'

export default function DetailPanel(): React.JSX.Element {
  const approvalQueue = useStore((s) => s.approvalQueue)
  const selectedApproval = useStore((s) => s.selectedApproval)
  const pendingToolCalls = useStore((s) => s.pendingToolCalls)
  const messages = useStore((s) => s.messages)
  const activeSessionId = useStore((s) => s.activeSessionId)
  const sessions = useStore((s) => s.sessions)
  const streaming = useStore((s) => s.streaming)
  const contextUsage = useStore((s) => s.contextUsage)
  const latestUsage = useStore((s) => s.latestUsage)
  const streamProviderName = useStore((s) => s.streamProviderName)
  const streamModelName = useStore((s) => s.streamModelName)
  const streamRunMode = useStore((s) => s.streamRunMode)
  const language = useStore((s) => s.language)
  const [collapsed, setCollapsed] = useState(() => typeof window !== 'undefined' && window.innerWidth < 1180)
  const [compactHidden, setCompactHidden] = useState(() => typeof window !== 'undefined' && window.innerWidth < 1180)
  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const activeApprovals = approvalQueue.filter((approval) => approval.sessionId === activeSessionId)
  const activePendingToolCalls = activeSessionId ? pendingToolCalls : []
  const visiblePendingToolCalls = visibleChatTools(activePendingToolCalls)
  const todoState = latestTodoState(activePendingToolCalls, messages)
  const activeSelectedApproval = selectedApproval?.sessionId === activeSessionId ? selectedApproval : null
  const researchProgress = deriveResearchProgress(activePendingToolCalls, messages, streaming, streamRunMode)
  const contextOptimization = contextUsage ? contextOptimizationView(contextUsage) : null

  useEffect(() => {
    const media = window.matchMedia('(max-width: 1179px)')
    const update = (): void => {
      setCompactHidden(media.matches)
      if (media.matches) setCollapsed(true)
    }
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  if (compactHidden) return <></>

  return (
    <aside className={`min-w-0 flex shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)] transition-[width] duration-200 ${collapsed ? 'w-12' : 'w-80'}`}>
      <div className={`border-b border-[var(--color-border)] ${collapsed ? 'p-2' : 'px-4 py-4'}`}>
        <div className="flex items-center justify-between gap-2">
          {!collapsed && <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">{t(language, 'detail.title')}</p>}
          {activeApprovals.length > 0 && <span className={`flex h-7 w-7 items-center justify-center rounded-md bg-[var(--color-accent)]/20 text-[var(--color-accent)] ${collapsed ? 'mx-auto' : ''}`} title={t(language, 'detail.pending', { count: activeApprovals.length })} aria-label={t(language, 'detail.pending', { count: activeApprovals.length })}><ShieldAlert size={15} /></span>}
          <button onClick={() => setCollapsed((value) => !value)} aria-expanded={!collapsed} aria-label={t(language, collapsed ? 'detail.expand' : 'detail.collapse')} title={t(language, collapsed ? 'detail.expand' : 'detail.collapse')} className="ml-auto flex h-8 w-8 items-center justify-center rounded-md text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]">
            {collapsed ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}
          </button>
        </div>
      </div>

      {!collapsed && <div className="flex-1 overflow-y-auto p-4">
        {!activeSession && <p className="text-sm text-[var(--color-text-muted)]">{t(language, 'detail.empty')}</p>}
        {activeSession && <div className="space-y-5">
          <section>
            <p className="text-xs uppercase tracking-widest text-[var(--color-text-muted)]">{t(language, 'detail.session')}</p>
            <p className="mt-1 truncate text-sm font-medium text-[var(--color-text-primary)]" title={activeSession.title}>{activeSession.title}</p>
            <p className="mt-1 break-all font-mono text-[10px] text-[var(--color-text-muted)]">{activeSession.id}</p>
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-widest text-[var(--color-text-muted)]">{t(language, 'detail.status')}</p>
              <span className={`text-xs ${streaming ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-secondary)]'}`}>{t(language, streaming ? 'detail.running' : 'detail.idle')}</span>
            </div>
            {(streamProviderName || streamModelName) && <p className="text-xs text-[var(--color-text-secondary)]">{streamProviderName ?? '—'} / {streamModelName ?? '—'}</p>}
          </section>

          {contextUsage && <section>
            <div className="flex items-center justify-between text-xs">
              <p className="uppercase tracking-widest text-[var(--color-text-muted)]">{t(language, 'detail.context')}</p>
              <span className="text-[var(--color-text-secondary)]">{contextUsage.percent}%</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--color-border)]"><div className="h-1.5 rounded-full bg-[var(--color-accent)]" style={{ width: `${Math.max(0, Math.min(100, contextUsage.percent))}%` }} /></div>
            <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">{contextUsage.inputTokens.toLocaleString()} / {contextUsage.maxTokens.toLocaleString()} tokens</p>
            <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-[var(--color-text-secondary)]">
              <span className="rounded bg-[var(--color-surface-active)] px-1.5 py-0.5">{t(language, contextUsage.source === 'provider' ? 'detail.providerMeasured' : 'detail.localEstimate')}</span>
              {contextUsage.stepNumber !== undefined && <span className="rounded bg-[var(--color-surface-active)] px-1.5 py-0.5">{t(language, 'detail.step', { count: contextUsage.stepNumber })}</span>}
              {(contextUsage.compressionCount ?? 0) > 0 && <span className="rounded bg-[var(--color-surface-active)] px-1.5 py-0.5">{t(language, 'detail.compressions', { count: contextUsage.compressionCount ?? 0 })}</span>}
            </div>
            {contextUsage.compressionBeforeTokens !== undefined && contextUsage.compressionAfterTokens !== undefined && <p className="mt-1 font-mono text-[10px] text-[var(--color-text-muted)]">{t(language, 'detail.compressionChange', { before: contextUsage.compressionBeforeTokens.toLocaleString(), after: contextUsage.compressionAfterTokens.toLocaleString() })}</p>}
            {contextUsage.compressionError && <p className="mt-1 break-words text-[10px] text-amber-400">{t(language, 'detail.compressionError', { error: contextUsage.compressionError })}</p>}
            {contextOptimization && <div className="mt-3 space-y-1.5 border-t border-[var(--color-border)] pt-2 text-[10px]">
              {(contextOptimization.mode || contextOptimization.policyVersion) && <div className="flex flex-wrap gap-1.5 text-[var(--color-text-secondary)]">
                {contextOptimization.mode && <span className="rounded bg-[var(--color-surface-active)] px-1.5 py-0.5">{t(language, 'context.modeValue', { mode: t(language, `context.mode.${contextOptimization.mode}`) })}</span>}
                {contextOptimization.policyVersion && <span className="rounded bg-[var(--color-surface-active)] px-1.5 py-0.5">{t(language, 'context.policyValue', { policy: contextOptimization.policyVersion })}</span>}
              </div>}
              {contextOptimization.latestTransform && <>
                <DetailMetric label={t(language, 'context.latestTransform')} value={`${contextOptimization.latestTransform.sourceType ? `${contextOptimization.latestTransform.sourceType} · ` : ''}${contextOptimization.latestTransform.transform}`} />
                <DetailMetric label={t(language, 'context.transformTokens')} value={`${contextOptimization.latestTransform.beforeTokens.toLocaleString()} → ${contextOptimization.latestTransform.afterTokens.toLocaleString()}`} mono />
                <DetailMetric label={t(language, 'context.retrievable')} value={t(language, contextOptimization.latestTransform.retrievable ? 'context.yes' : 'context.no')} />
              </>}
              <DetailMetric label={t(language, 'context.summaryCost')} value={`${contextOptimization.summaryInputTokens.toLocaleString()} + ${contextOptimization.summaryOutputTokens.toLocaleString()}`} mono />
              <DetailMetric label={t(language, 'context.estimatedNetSaved')} value={contextOptimization.estimatedNetSavedTokens === undefined ? '—' : `${contextOptimization.estimatedNetSavedTokens > 0 ? '+' : ''}${contextOptimization.estimatedNetSavedTokens.toLocaleString()}`} mono />
              <DetailMetric label={t(language, 'context.retrievalCount')} value={contextOptimization.retrievalFailureCount > 0 ? `${contextOptimization.retrievalCount} (${t(language, 'context.retrievalFailures', { count: contextOptimization.retrievalFailureCount })})` : String(contextOptimization.retrievalCount)} />
              {contextOptimization.error && <p className="break-words text-amber-400">{t(language, 'context.errorValue', { error: contextOptimization.error })}</p>}
            </div>}
          </section>}

          {latestUsage && <section>
            <p className="mb-2 text-xs uppercase tracking-widest text-[var(--color-text-muted)]">{t(language, 'detail.usage')}</p>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
              <UsageRow label={t(language, 'detail.inputTokens')} value={latestUsage.inputTokens} />
              <UsageRow label={t(language, 'detail.outputTokens')} value={latestUsage.outputTokens} />
              <UsageRow label={t(language, 'detail.totalTokens')} value={latestUsage.totalTokens} />
              <UsageRow label={t(language, 'detail.noCacheTokens')} value={latestUsage.noCacheTokens} />
              <UsageRow label={t(language, 'detail.cacheReadTokens')} value={latestUsage.cacheReadTokens} />
              <UsageRow label={t(language, 'detail.cacheWriteTokens')} value={latestUsage.cacheWriteTokens} />
              <UsageRow label={t(language, 'detail.modelSteps')} value={latestUsage.stepCount} />
            </div>
          </section>}

          {researchProgress && <section role="status" aria-live="polite" className="rounded-lg bg-[var(--color-bg)] p-3 shadow-[inset_0_0_0_1px_var(--color-border)]">
            <div className="flex items-center justify-between gap-2"><p className="text-xs uppercase tracking-widest text-[var(--color-text-muted)]">{t(language, 'research.progress.title')}</p><span className={`text-xs font-medium ${researchProgress.stage === 'error' ? 'text-red-400' : researchProgress.stage === 'completed' ? 'text-emerald-400' : 'text-[var(--color-accent)]'}`}>{t(language, `research.progress.${researchProgress.stage}`)}</span></div>
            <p className="mt-2 text-[10px] tabular-nums text-[var(--color-text-muted)]">{t(language, 'research.progress.counts', { searches: researchProgress.searchCount, reads: researchProgress.readCount })}</p>
          </section>}

          {todoState && <section>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs uppercase tracking-widest text-[var(--color-text-muted)]">{t(language, 'detail.tasks')}</p>
              <span className="font-mono text-[10px] tabular-nums text-[var(--color-text-secondary)]">{todoState.completed}/{todoState.total}</span>
            </div>
            <div className="space-y-1.5">
              {todoState.items.map((todo, index) => {
                const Icon = todo.status === 'completed' ? CircleCheck : todo.status === 'in_progress' ? CircleDot : Circle
                return <div key={`${todo.content}-${index}`} className={`flex items-start gap-2 rounded-md px-2 py-1.5 text-xs ${todo.status === 'in_progress' ? 'bg-[var(--color-accent)]/10 text-[var(--color-text-primary)]' : todo.status === 'completed' ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-text-secondary)]'}`}><Icon size={13} className={`mt-0.5 shrink-0 ${todo.status === 'completed' ? 'text-emerald-400' : todo.status === 'in_progress' ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'}`} /><span className={todo.status === 'completed' ? 'line-through opacity-75' : ''}>{todo.content}</span></div>
              })}
            </div>
          </section>}

          {visiblePendingToolCalls.length > 0 && <section>
            <p className="mb-2 text-xs uppercase tracking-widest text-[var(--color-text-muted)]">{t(language, 'detail.tools')}</p>
            <ToolCallList toolCalls={visiblePendingToolCalls} />
          </section>}

          {activeApprovals.length === 0 && visiblePendingToolCalls.length === 0 && !todoState && !contextUsage && !latestUsage && <p className="text-sm text-[var(--color-text-muted)]">{t(language, 'detail.empty')}</p>}

          {activeSelectedApproval && <section className="border-t border-[var(--color-border)] pt-4">
            <p className="mb-2 text-xs uppercase tracking-widest text-[var(--color-text-muted)]">{t(language, 'detail.approval')}</p>
            <ApprovalPanel key={activeSelectedApproval.requestId} approval={activeSelectedApproval} />
          </section>}
        </div>}
      </div>}
    </aside>
  )
}

function DetailMetric({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): React.JSX.Element {
  return <div className="flex items-start justify-between gap-3"><span className="text-[var(--color-text-muted)]">{label}</span><span className={`max-w-[58%] break-words text-right text-[var(--color-text-primary)] ${mono ? 'font-mono tabular-nums' : ''}`}>{value}</span></div>
}

function UsageRow({ label, value }: { label: string; value: number | undefined }): React.JSX.Element {
  return (
    <div className="contents">
      <span className="text-[var(--color-text-muted)]">{label}</span>
      <span className="text-right font-mono tabular-nums text-[var(--color-text-primary)]">{value === undefined ? '—' : value.toLocaleString()}</span>
    </div>
  )
}
