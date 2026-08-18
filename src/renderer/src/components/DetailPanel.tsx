import { useEffect, useMemo, useState } from 'react'
import { PanelRightClose, PanelRightOpen, ShieldAlert, Circle, CircleCheck, CircleDot } from 'lucide-react'
import { useStore } from '../store'
import { t } from '../i18n'
import type { GoalState, GoalStatus, StreamUsage, ToolRecoveryRecord, ToolRecoveryResolution } from '@shared/types'
import ToolCallList from './ToolCallList'
import { latestTodoState } from '../detail-todos'
import { visibleChatTools } from '../tool-visibility'
import { deriveResearchProgress } from '../research-progress'
import { contextOptimizationView } from '../context-optimization-ui'
import { toRunActivityViewModel, formatElapsedDuration } from '../run-activity'
import { subagentActivitiesForView } from '../subagent-activity'
import SubagentActivityList from './SubagentActivityList'

interface Props {
  onGoalAction?: (action: 'pause' | 'resume' | 'clear') => void | Promise<void>
}

export default function DetailPanel({ onGoalAction }: Props): React.JSX.Element {
  const approvalQueue = useStore((s) => s.approvalQueue)
  const pendingToolCalls = useStore((s) => s.pendingToolCalls)
  const liveSubagentActivities = useStore((s) => s.subagentActivities)
  const messages = useStore((s) => s.messages)
  const activeSessionId = useStore((s) => s.activeSessionId)
  const sessions = useStore((s) => s.sessions)
  const streaming = useStore((s) => s.streaming)
  const contextUsage = useStore((s) => s.contextUsage)
  const latestUsage = useStore((s) => s.latestUsage)
  const streamProviderName = useStore((s) => s.streamProviderName)
  const streamModelName = useStore((s) => s.streamModelName)
  const streamRunMode = useStore((s) => s.streamRunMode)
  const runActivity = useStore((s) => s.runActivity)
  const streamFlow = useStore((s) => s.streamFlow)
  const language = useStore((s) => s.language)
  const [collapsed, setCollapsed] = useState(() => typeof window !== 'undefined' && window.innerWidth < 1180)
  const [compactHidden, setCompactHidden] = useState(() => typeof window !== 'undefined' && window.innerWidth < 1180)
  const [recoveries, setRecoveries] = useState<ToolRecoveryRecord[]>([])
  const [resolvingRecovery, setResolvingRecovery] = useState<string | null>(null)
  const [elapsedNow, setElapsedNow] = useState(Date.now())
  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const activeApprovals = approvalQueue.filter((approval) => approval.sessionId === activeSessionId)
  const activePendingToolCalls = activeSessionId ? pendingToolCalls : []
  const visiblePendingToolCalls = visibleChatTools(activePendingToolCalls).filter((tool) => tool.toolName !== 'Agent')
  const subagentActivities = subagentActivitiesForView(activeSessionId ? liveSubagentActivities : [], messages)
  const todoState = latestTodoState(activePendingToolCalls, messages)
  const researchProgress = deriveResearchProgress(activePendingToolCalls, messages, streaming, streamRunMode)
  const contextOptimization = contextUsage ? contextOptimizationView(contextUsage) : null
  const activityView = toRunActivityViewModel(runActivity, language)
  const activityStartedAt = activeSession?.activity.runId === runActivity.runId
    ? activeSession.activity.startedAt
    : undefined
  const elapsedDuration = streaming && activityStartedAt !== undefined
    ? formatElapsedDuration(elapsedNow - activityStartedAt)
    : null
  const { sessionUsage, assistantUsageCount } = useMemo(() => {
    const cumulative: StreamUsage = {}
    let count = 0
    for (const message of messages) {
      if (message.role !== 'assistant' || !message.usage) continue
      count += 1
      for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'noCacheTokens', 'cacheReadTokens', 'cacheWriteTokens', 'stepCount'] as const) {
        const value = message.usage[key]
        if (value !== undefined) cumulative[key] = (cumulative[key] ?? 0) + value
      }
      if (message.usage.firstTokenMs !== undefined) cumulative.firstTokenMs = Math.min(cumulative.firstTokenMs ?? Number.MAX_SAFE_INTEGER, message.usage.firstTokenMs)
      if (message.usage.generationMs !== undefined) cumulative.generationMs = (cumulative.generationMs ?? 0) + message.usage.generationMs
    }
    return { sessionUsage: cumulative, assistantUsageCount: count }
  }, [messages])

  useEffect(() => {
    let cancelled = false
    if (!activeSessionId) { setRecoveries([]); return }
    void window.joker.session.listRecoveries(activeSessionId).then((items) => { if (!cancelled) setRecoveries(items) })
    return () => { cancelled = true }
  }, [activeSessionId, messages, streaming])

  const resolveRecovery = async (recovery: ToolRecoveryRecord, resolution: ToolRecoveryResolution): Promise<void> => {
    if (!activeSessionId || resolvingRecovery) return
    setResolvingRecovery(recovery.recoveryId)
    try {
      const result = await window.joker.session.resolveRecovery(activeSessionId, { recoveryId: recovery.recoveryId, expectedRevision: recovery.revision, resolution })
      if (!result.success && result.error === 'conflict' && result.recovery) {
        setRecoveries((items) => items.map((item) => item.recoveryId === result.recovery!.recoveryId ? result.recovery! : item))
      } else {
        setRecoveries(await window.joker.session.listRecoveries(activeSessionId))
      }
    } finally {
      setResolvingRecovery(null)
    }
  }

  useEffect(() => {
    if (!streaming || activityStartedAt === undefined) return
    setElapsedNow(Date.now())
    const timer = window.setInterval(() => setElapsedNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [activityStartedAt, streaming])

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
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs uppercase tracking-widest text-[var(--color-text-muted)]">{t(language, 'detail.status')}</p>
              <div className="flex min-w-0 items-center gap-2">
                {elapsedDuration && <span data-detail-run-duration className="font-mono text-[10px] tabular-nums text-[var(--color-text-muted)]" title={t(language, 'detail.elapsed')}>{elapsedDuration}</span>}
                <span data-detail-run-status={activityView.phase} className={`truncate text-xs ${streaming ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-secondary)]'}`}>{activityView.label}</span>
              </div>
            </div>
            {(streamProviderName || streamModelName) && <p className="text-xs text-[var(--color-text-secondary)]">{streamProviderName ?? '—'} / {streamModelName ?? '—'}</p>}
          </section>

          {(streaming || streamFlow) && <section className="rounded-lg bg-[var(--color-bg)] p-3 shadow-[inset_0_0_0_1px_var(--color-border)]">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs uppercase tracking-widest text-[var(--color-text-muted)]">{t(language, 'detail.transport')}</p>
              <span className={`text-[10px] font-medium ${streamFlow?.blockedSince ? 'text-amber-400' : 'text-emerald-400'}`}>{t(language, streamFlow?.blockedSince ? 'detail.transportBlocked' : 'detail.transportHealthy')}</span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] text-[var(--color-text-secondary)]">
              <span>{t(language, 'detail.transportQueue')}</span><span className="text-right font-mono tabular-nums">{streamFlow ? `${streamFlow.queueDepth} / ${streamFlow.inFlight}` : '—'}</span>
              <span>{t(language, 'detail.transportAckAge')}</span><span className="text-right font-mono tabular-nums">{streamFlow?.lastAckAt ? formatStatusAge(elapsedNow - streamFlow.lastAckAt) : '—'}</span>
              <span>{t(language, 'detail.transportBlockedFor')}</span><span className="text-right font-mono tabular-nums">{streamFlow?.blockedSince ? formatStatusAge(elapsedNow - streamFlow.blockedSince) : '—'}</span>
            </div>
          </section>}

          {recoveries.some((item) => item.status === 'unresolved') && <section data-tool-recovery-panel className="rounded-lg border border-amber-700/60 bg-amber-950/20 p-3">
            <p className="text-xs font-semibold text-amber-300">{language === 'zh' ? '需要处理的工具结果' : 'Tool outcomes need review'}</p>
            <p className="mt-1 text-[11px] text-[var(--color-text-secondary)]">{language === 'zh' ? '上一次运行在工具开始后中断，结果未知。为避免重复副作用，相同调用已暂停。' : 'A previous run stopped after a tool started, so its outcome is unknown. Identical retries are paused.'}</p>
            <div className="mt-3 space-y-2">
              {recoveries.filter((item) => item.status === 'unresolved').map((recovery) => <div key={recovery.recoveryId} data-tool-recovery-id={recovery.recoveryId} className="rounded-md bg-[var(--color-bg)] p-2">
                <div className="flex items-center justify-between gap-2"><span className="text-xs font-medium">{recovery.toolName}</span><span className="font-mono text-[9px] text-[var(--color-text-muted)]">{recovery.recoveryId.slice(0, 8)}</span></div>
                <div className="mt-2 grid gap-1">
                  <button disabled={resolvingRecovery === recovery.recoveryId} onClick={() => void resolveRecovery(recovery, 'verified-not-applied')} className="rounded bg-amber-500/15 px-2 py-1 text-left text-[10px] text-amber-200 hover:bg-amber-500/25">{language === 'zh' ? '确认未执行，允许重试' : 'Confirm not applied; allow retry'}</button>
                  <button disabled={resolvingRecovery === recovery.recoveryId} onClick={() => void resolveRecovery(recovery, 'verified-applied')} className="rounded bg-[var(--color-surface)] px-2 py-1 text-left text-[10px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]">{language === 'zh' ? '确认已经执行，不再重试' : 'Confirm applied; do not retry'}</button>
                </div>
              </div>)}
            </div>
          </section>}

          {activeSession.goal && <GoalCard goal={activeSession.goal} language={language} streaming={streaming} onAction={onGoalAction} />}

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

          {latestUsage && <section data-token-ledger>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs uppercase tracking-widest text-[var(--color-text-muted)]">{t(language, 'detail.usage')}</p>
              <span className="font-mono text-[10px] tabular-nums text-[var(--color-text-secondary)]">{t(language, 'detail.usageRuns', { count: assistantUsageCount })}</span>
            </div>
            <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 gap-y-1.5 text-xs">
              <span />
              <span className="text-center text-[10px] font-medium text-[var(--color-text-secondary)]">{t(language, 'detail.usageLastRun')}</span>
              <span className="text-center text-[10px] font-medium text-[var(--color-text-secondary)]">{t(language, 'detail.usageSessionTotal')}</span>
              <UsageRow label={t(language, 'detail.inputTokens')} value={latestUsage.inputTokens} total={sessionUsage.inputTokens} />
              <UsageRow label={t(language, 'tokens.cache')} value={latestUsage.cacheReadTokens} total={sessionUsage.cacheReadTokens} indent />
              <UsageRow label={t(language, 'tokens.cacheWrite')} value={latestUsage.cacheWriteTokens} total={sessionUsage.cacheWriteTokens} indent />
              <UsageRow label={t(language, 'detail.noCacheTokens')} value={latestUsage.noCacheTokens} total={sessionUsage.noCacheTokens} indent />
              <UsageRow label={t(language, 'detail.outputTokens')} value={latestUsage.outputTokens} total={sessionUsage.outputTokens} />
              <UsageRow label={t(language, 'detail.totalTokens')} value={latestUsage.totalTokens} total={sessionUsage.totalTokens} strong />
              <UsageRow label={t(language, 'detail.modelSteps')} value={latestUsage.stepCount} total={sessionUsage.stepCount} />
              <UsageRow label={t(language, 'detail.ttft')} value={latestUsage.firstTokenMs === undefined ? undefined : formatMs(latestUsage.firstTokenMs)} total={sessionUsage.firstTokenMs === undefined ? undefined : formatMs(sessionUsage.firstTokenMs)} />
              <UsageRow label={t(language, 'detail.throughput')} value={formatTokPerSec(latestUsage)} total={sessionUsage.outputTokens !== undefined && sessionUsage.generationMs !== undefined && sessionUsage.generationMs > 0 ? `${(sessionUsage.outputTokens / (sessionUsage.generationMs / 1000)).toFixed(1)} tok/s` : undefined} />
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

          {subagentActivities.length > 0 && <section>
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-xs uppercase tracking-widest text-[var(--color-text-muted)]">{t(language, 'detail.subagents')}</p>
              <span className="font-mono text-[10px] tabular-nums text-[var(--color-text-secondary)]">{subagentActivities.length}</span>
            </div>
            <SubagentActivityList activities={subagentActivities} language={language} now={elapsedNow} />
          </section>}

          {visiblePendingToolCalls.length > 0 && <section>
            <p className="mb-2 text-xs uppercase tracking-widest text-[var(--color-text-muted)]">{t(language, 'detail.tools')}</p>
            <ToolCallList toolCalls={visiblePendingToolCalls} />
          </section>}

          {activeApprovals.length === 0 && visiblePendingToolCalls.length === 0 && subagentActivities.length === 0 && !todoState && !contextUsage && !latestUsage && <p className="text-sm text-[var(--color-text-muted)]">{t(language, 'detail.empty')}</p>}
        </div>}
      </div>}
    </aside>
  )
}

function GoalCard({ goal, language, streaming, onAction }: { goal: GoalState; language: 'zh' | 'en'; streaming: boolean; onAction?: Props['onGoalAction'] }): React.JSX.Element {
  const total = usageTotal(goal.cumulativeUsage)
  const canPause = streaming && (goal.status === 'executing' || goal.status === 'validating' || goal.status === 'queued')
  const hardBlocked = goal.status === 'blocked' && (goal.stopReason === 'max-rounds' || goal.stopReason === 'token-limit')
  const canResume = !streaming && !hardBlocked && (goal.status === 'paused' || goal.status === 'interrupted' || goal.status === 'blocked')
  const canClear = !streaming || goal.status !== 'executing'
  return <section role="status" aria-live="polite" data-goal-card data-goal-status={goal.status} className="rounded-lg bg-[var(--color-bg)] p-3 shadow-[inset_0_0_0_1px_var(--color-border)]">
    <div className="flex items-center justify-between gap-2">
      <p className="text-xs uppercase tracking-widest text-[var(--color-text-muted)]">{t(language, 'detail.goal')}</p>
      <span className={`text-xs font-medium ${goal.status === 'completed' ? 'text-emerald-400' : goal.status === 'blocked' ? 'text-amber-400' : 'text-[var(--color-accent)]'}`}>{goalStatusLabel(language, goal.status)}</span>
    </div>
    <p className="mt-2 break-words text-xs text-[var(--color-text-primary)]">{goal.objective}</p>
    <div className="mt-2 grid grid-cols-2 gap-1 text-[10px] text-[var(--color-text-muted)]">
      <span>{t(language, 'detail.goalRound', { round: goal.currentRound, max: goal.maxRounds })}</span>
      <span className="text-right tabular-nums">{goal.tokenLimit === undefined
        ? t(language, 'detail.goalUsageUnlimited', { used: total.toLocaleString() })
        : t(language, 'detail.goalBudget', { used: total.toLocaleString(), limit: goal.tokenLimit.toLocaleString() })}</span>
    </div>
    {goal.stopReason && <p className="mt-1 break-words text-[10px] text-amber-400">{t(language, 'detail.goalStopReason', { reason: goalStopReasonLabel(language, goal.stopReason) })}</p>}
    {goal.feedback && <p className="mt-1 break-words text-[10px] text-amber-400">{goal.feedback}</p>}
    {onAction && <div className="mt-3 flex flex-wrap gap-1.5">
      {canPause && <GoalButton label={t(language, 'detail.goalPause')} onClick={() => onAction('pause')} />}
      {canResume && <GoalButton label={t(language, 'detail.goalResume')} onClick={() => onAction('resume')} />}
      {canClear && <GoalButton label={t(language, 'detail.goalClear')} onClick={() => onAction('clear')} muted />}
    </div>}
  </section>
}

function GoalButton({ label, onClick, muted = false }: { label: string; onClick: () => void | Promise<void>; muted?: boolean }): React.JSX.Element {
  return <button type="button" onClick={() => void onClick()} className={`rounded-md border px-2 py-1 text-[10px] transition ${muted ? 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]' : 'border-[var(--color-accent)]/50 bg-[var(--color-accent)]/10 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/20'}`}>{label}</button>
}

function usageTotal(usage: StreamUsage): number {
  return Math.max(usage.totalTokens ?? 0, (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0))
}

function goalStatusLabel(language: 'zh' | 'en', status: GoalStatus): string {
  return t(language, `goal.status.${status}`)
}

function goalStopReasonLabel(language: 'zh' | 'en', reason: NonNullable<GoalState['stopReason']>): string {
  return t(language, `goal.stopReason.${reason}`)
}

function DetailMetric({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): React.JSX.Element {
  return <div className="flex items-start justify-between gap-3"><span className="text-[var(--color-text-muted)]">{label}</span><span className={`max-w-[58%] break-words text-right text-[var(--color-text-primary)] ${mono ? 'font-mono tabular-nums' : ''}`}>{value}</span></div>
}

function formatStatusAge(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`
}

function UsageRow({ label, value, total, indent = false, strong = false }: { label: string; value: number | string | undefined; total?: number | string; indent?: boolean; strong?: boolean }): React.JSX.Element {
  return (
    <>
      <span className={`text-[var(--color-text-muted)] ${indent ? 'pl-3 text-[10px]' : ''} ${strong ? 'font-medium text-[var(--color-text-secondary)]' : ''}`}>{label}</span>
      <span className={`text-right font-mono tabular-nums ${strong ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)]'} ${indent ? 'text-[10px]' : ''}`}>{value === undefined ? '—' : typeof value === 'number' ? value.toLocaleString() : value}</span>
      <span className={`text-right font-mono tabular-nums ${strong ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)]'} ${indent ? 'text-[10px]' : ''}`}>{total === undefined ? '—' : typeof total === 'number' ? total.toLocaleString() : total}</span>
    </>
  )
}

function formatMs(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`
}

function formatTokPerSec(usage: StreamUsage): string | undefined {
  if (usage.outputTokens === undefined || usage.generationMs === undefined || usage.generationMs <= 0) return undefined
  return `${(usage.outputTokens / (usage.generationMs / 1000)).toFixed(1)} tok/s`
}
