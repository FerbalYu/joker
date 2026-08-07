import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Boxes, RefreshCw, ShieldCheck } from 'lucide-react'

import type {
  GeneratedToolContinuationView,
  GeneratedToolDetail,
  GeneratedToolInventoryItem,
  GeneratedToolsInventorySnapshot
} from '@shared/types'
import { localizeError, t, type Language } from '../../i18n'
import ToolWorkbench from './ToolWorkbench'
import { isStaleGeneratedToolsCasError, shouldPollGeneratedTools } from './generated-tools-settings-state'

interface Props {
  language: Language
  initialToolId?: string
  initialFocus?: 'overview' | 'edit'
  editRequestedFrom?: 'settings' | 'conversation'
  onCreateInConversation?: () => void
}

function statusClass(item: GeneratedToolInventoryItem): string {
  if (item.availability === 'available' && item.executable) return 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300'
  if (item.availability === 'building' || item.availability === 'validating') return 'border-sky-400/25 bg-sky-400/10 text-sky-300'
  if (item.availability === 'changed' || item.availability === 'quarantined') return 'border-amber-400/25 bg-amber-400/10 text-amber-300'
  if (item.availability === 'failed' || item.availability === 'missing') return 'border-red-400/25 bg-red-400/10 text-red-300'
  return 'border-[var(--color-border-light)] bg-[var(--color-surface-active)] text-[var(--color-text-secondary)]'
}

function formatTime(value: number | undefined, language: Language): string {
  return value === undefined ? '—' : new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(value)
}

export default function GeneratedToolsSettings({
  language,
  initialToolId,
  initialFocus = 'overview',
  editRequestedFrom = 'settings',
  onCreateInConversation
}: Props): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<GeneratedToolsInventorySnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [inventoryError, setInventoryError] = useState('')
  const [continuationError, setContinuationError] = useState('')
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null)
  const [detail, setDetail] = useState<GeneratedToolDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [promoting, setPromoting] = useState(false)
  const [promoteError, setPromoteError] = useState('')
  const [continuations, setContinuations] = useState<GeneratedToolContinuationView[]>([])
  const detailRequestRef = useRef(0)
  const mountedRef = useRef(true)
  const loadGenerationRef = useRef(0)
  const loadPromiseRef = useRef<Promise<GeneratedToolsInventorySnapshot | null> | null>(null)
  const refreshRequestedRef = useRef(false)
  const snapshotRef = useRef<GeneratedToolsInventorySnapshot | null>(null)

  const applySnapshot = useCallback((nextSnapshot: GeneratedToolsInventorySnapshot): void => {
    snapshotRef.current = nextSnapshot
    setSnapshot(nextSnapshot)
  }, [])

  useEffect(() => {
    snapshotRef.current = snapshot
  }, [snapshot])

  const applyContinuations = useCallback((nextContinuations: GeneratedToolContinuationView[]): void => {
    setContinuations(nextContinuations)
  }, [])

  const load = useCallback((): Promise<GeneratedToolsInventorySnapshot | null> => {
    refreshRequestedRef.current = true
    if (loadPromiseRef.current) return loadPromiseRef.current

    const generation = ++loadGenerationRef.current
    const request = (async (): Promise<GeneratedToolsInventorySnapshot | null> => {
      let latestSnapshot: GeneratedToolsInventorySnapshot | null = snapshotRef.current
      do {
        refreshRequestedRef.current = false
        if (!mountedRef.current || generation !== loadGenerationRef.current) break
        setLoading(true)
        setInventoryError('')
        setContinuationError('')
        try {
          const result = await window.joker.generatedTools.list()
          if (!mountedRef.current || generation !== loadGenerationRef.current) break
          if (!result.success) {
            setInventoryError(localizeError(language, result.error.message))
            break
          }
          latestSnapshot = result.data
          applySnapshot(result.data)

          try {
            const continuationResult = await window.joker.generatedTools.continuations()
            if (!mountedRef.current || generation !== loadGenerationRef.current) break
            if (continuationResult.success) applyContinuations(continuationResult.data)
            else setContinuationError(localizeError(language, continuationResult.error.message))
          } catch (continuationFailure) {
            if (!mountedRef.current || generation !== loadGenerationRef.current) break
            setContinuationError(localizeError(language, continuationFailure instanceof Error ? continuationFailure.message : String(continuationFailure)))
          }
        } catch (loadError) {
          if (!mountedRef.current || generation !== loadGenerationRef.current) break
          setInventoryError(localizeError(language, loadError instanceof Error ? loadError.message : String(loadError)))
        }
      } while (refreshRequestedRef.current && mountedRef.current && generation === loadGenerationRef.current)

      if (mountedRef.current && generation === loadGenerationRef.current) setLoading(false)
      return latestSnapshot
    })()
    loadPromiseRef.current = request
    void request.finally(() => {
      if (loadPromiseRef.current === request) loadPromiseRef.current = null
    })
    return request
  }, [applyContinuations, applySnapshot, language])

  const [qualificationBusy, setQualificationBusy] = useState(false)
  const qualificationOperation = snapshot?.qualificationOperation ?? null
  const polling = shouldPollGeneratedTools(snapshot, continuations)

  useEffect(() => {
    if (!polling) return
    const timer = window.setTimeout(() => { void load() }, 1_000)
    return () => window.clearTimeout(timer)
  }, [load, polling, snapshot, continuations])

  const startQualification = async (): Promise<void> => {
    if (qualificationBusy) return
    setQualificationBusy(true)
    setInventoryError('')
    try {
      const result = await window.joker.generatedTools.startQualification()
      if (!mountedRef.current) return
      if (!result.success) setInventoryError(localizeError(language, result.error.message))
      await load()
    } catch (startError) {
      if (mountedRef.current) setInventoryError(localizeError(language, startError instanceof Error ? startError.message : String(startError)))
    } finally {
      if (mountedRef.current) setQualificationBusy(false)
    }
  }

  const cancelQualification = async (): Promise<void> => {
    if (qualificationBusy) return
    setQualificationBusy(true)
    try {
      const result = await window.joker.generatedTools.cancelQualification()
      if (!mountedRef.current) return
      if (!result.success) setInventoryError(localizeError(language, result.error.message))
      await load()
    } catch (cancelError) {
      if (mountedRef.current) setInventoryError(localizeError(language, cancelError instanceof Error ? cancelError.message : String(cancelError)))
    } finally {
      if (mountedRef.current) setQualificationBusy(false)
    }
  }

  useEffect(() => {
    mountedRef.current = true
    void load()
    return () => {
      mountedRef.current = false
      loadGenerationRef.current += 1
      loadPromiseRef.current = null
      detailRequestRef.current += 1
    }
  }, [load])

  const openWorkbench = useCallback(async (toolId: string): Promise<void> => {
    const requestId = ++detailRequestRef.current
    setSelectedToolId(toolId)
    setDetail(null)
    setDetailError('')
    setDetailLoading(true)
    try {
      const result = await window.joker.generatedTools.get(toolId)
      if (!mountedRef.current || detailRequestRef.current !== requestId) return
      if (!result.success) {
        setDetailError(localizeError(language, result.error.message))
        return
      }
      setDetail(result.data)
    } catch (loadError) {
      if (!mountedRef.current || detailRequestRef.current !== requestId) return
      setDetailError(localizeError(language, loadError instanceof Error ? loadError.message : String(loadError)))
    } finally {
      if (mountedRef.current && detailRequestRef.current === requestId) setDetailLoading(false)
    }
  }, [language])

  useEffect(() => {
    if (initialToolId) void openWorkbench(initialToolId)
  }, [initialToolId, openWorkbench])

  const promoteCandidate = async (candidateToolId?: string): Promise<void> => {
    if (promoting) return
    const targetToolId = candidateToolId ?? selectedToolId
    let candidate = candidateToolId
      ? snapshotRef.current?.tools.find((tool) => tool.toolId === candidateToolId)?.candidate
      : detail?.summary.candidate
    if (!candidate && targetToolId) {
      const result = await window.joker.generatedTools.get(targetToolId)
      if (!mountedRef.current) return
      if (!result.success) {
        setPromoteError(localizeError(language, result.error.message))
        return
      }
      candidate = result.data.summary.candidate
    }
    if (!candidate?.candidateFingerprint || candidate.status !== 'awaiting-policy') return
    setPromoting(true)
    setPromoteError('')
    try {
      const result = await window.joker.generatedTools.promote({
        jobId: candidate.jobId,
        expectedJobRevision: candidate.jobRevision,
        registryRevision: snapshotRef.current?.registryRevision ?? detail?.registryRevision ?? 0,
        expectedCandidateFingerprint: candidate.candidateFingerprint
      })
      if (!mountedRef.current) return
      if (!result.success) {
        if (isStaleGeneratedToolsCasError(result.error)) {
          await load()
          if (targetToolId) await openWorkbench(targetToolId)
          return
        }
        setPromoteError(localizeError(language, result.error.message))
        return
      }
      const nextSnapshot = await load()
      if (targetToolId && nextSnapshot?.tools.find((tool) => tool.toolId === targetToolId)?.activeVersionId) {
        await openWorkbench(targetToolId)
      }
    } catch (promoteFailure) {
      if (!mountedRef.current) return
      if (isStaleGeneratedToolsCasError(promoteFailure)) {
        await load()
        if (targetToolId) await openWorkbench(targetToolId)
        return
      }
      setPromoteError(localizeError(language, promoteFailure instanceof Error ? promoteFailure.message : String(promoteFailure)))
    } finally {
      if (mountedRef.current) setPromoting(false)
    }
  }

  const mutateLifecycle = async (action: 'disable' | 'reenable' | 'rollback' | 'revalidate' | 'remove', versionId?: string): Promise<void> => {
    const targetDetail = detail
    const targetToolId = selectedToolId
    if (!targetDetail || !targetToolId) return
    const input = {
      toolId: targetToolId,
      expectedRevision: targetDetail.registryRevision,
      operationId: crypto.randomUUID()
    }
    try {
      if (action === 'remove') {
        const result = await window.joker.generatedTools.remove(input)
        if (!result.success) throw new Error(localizeError(language, result.error ?? t(language, 'toolforge.lifecycleFailed')))
        if (mountedRef.current && selectedToolId === targetToolId) {
          detailRequestRef.current += 1
          setSelectedToolId(null)
          setDetail(null)
          setDetailError('')
          setDetailLoading(false)
        }
        await load()
        return
      }
      if (action === 'disable') {
        const result = await window.joker.generatedTools.disable(input)
        if (!result.success) throw new Error(localizeError(language, result.error ?? t(language, 'toolforge.lifecycleFailed')))
      } else if (action === 'revalidate') {
        if (!versionId) throw new Error(t(language, 'toolforge.lifecycleFailed'))
        const result = await window.joker.generatedTools.revalidate({ ...input, versionId })
        if (!result.success) throw new Error(localizeError(language, result.error.message))
      } else {
        if (!versionId) throw new Error(t(language, 'toolforge.lifecycleFailed'))
        const result = action === 'reenable'
          ? await window.joker.generatedTools.reenable({ ...input, versionId })
          : await window.joker.generatedTools.rollback({ ...input, versionId })
        if (!result.success) throw new Error(localizeError(language, result.error ?? t(language, 'toolforge.lifecycleFailed')))
      }
      await load()
      if (mountedRef.current && selectedToolId === targetToolId) await openWorkbench(targetToolId)
    } catch (mutationError) {
      if (isStaleGeneratedToolsCasError(mutationError)) {
        await load()
        if (mountedRef.current && selectedToolId === targetToolId) await openWorkbench(targetToolId)
        return
      }
      throw mutationError
    }
  }

  return (
    <section aria-labelledby="generated-tools-settings-title">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Boxes size={19} className="text-[var(--color-accent)]" />
            <h3 id="generated-tools-settings-title" className="text-lg font-semibold text-[var(--color-text-primary)]">{t(language, 'settings.generatedTools')}</h3>
          </div>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-[var(--color-text-muted)]">{t(language, 'settings.generatedToolsDescription')}</p>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading} className="flex min-h-10 items-center gap-2 rounded-md border border-[var(--color-border)] px-3 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] disabled:opacity-40">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> {t(language, 'settings.generatedToolsRefresh')}
        </button>
      </div>

      {qualificationOperation && ['queued', 'running'].includes(qualificationOperation.status) && (
        <div role="status" aria-live="polite" data-testid="generated-tools-qualification-running" className="mb-4 rounded-lg border border-sky-400/20 bg-sky-400/10 px-4 py-3 text-sm text-sky-200">
          <div className="flex items-center justify-between gap-3">
            <span>{qualificationOperation.phase ?? t(language, 'toolforge.qualificationVerifying')} · {qualificationOperation.completedChecks}/{qualificationOperation.totalChecks}</span>
            <button type="button" onClick={() => void cancelQualification()} disabled={qualificationBusy} className="rounded border border-sky-300/30 px-2 py-1 text-xs hover:bg-sky-300/10 disabled:opacity-50">{t(language, 'toolforge.qualificationCancel')}</button>
          </div>
        </div>
      )}
      {!snapshot?.qualification && qualificationOperation && ['failed', 'interrupted'].includes(qualificationOperation.status) && !loading && !inventoryError && (
        <div data-testid="generated-tools-qualification-failed" className="mb-4 rounded-lg border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-200">
          <div>{qualificationOperation.error ?? t(language, 'toolforge.qualificationFailed')}</div>
          <button type="button" onClick={() => void startQualification()} disabled={qualificationBusy} className="mt-3 rounded-md bg-red-300/15 px-3 py-1.5 text-xs font-semibold hover:bg-red-300/25 disabled:opacity-50">{t(language, 'toolforge.qualificationRetry')}</button>
        </div>
      )}
      {!snapshot?.qualification && (!qualificationOperation || ['completed', 'cancelled'].includes(qualificationOperation.status)) && !loading && !inventoryError && (
        <div data-testid="generated-tools-qualification-missing" className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
          <AlertTriangle size={16} /> <span>{snapshot?.tools.length ? t(language, 'toolforge.qualificationMissing') : t(language, 'toolforge.qualificationNotVerified')}</span>
          <button type="button" onClick={() => void startQualification()} disabled={qualificationBusy} className="rounded-md bg-amber-300/15 px-3 py-1.5 text-xs font-semibold hover:bg-amber-300/25 disabled:opacity-50">{qualificationBusy ? t(language, 'toolforge.qualificationVerifying') : t(language, 'toolforge.qualificationVerify')}</button>
        </div>
      )}

      {snapshot?.qualification ? (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 text-sm">
          <ShieldCheck size={16} className="text-[var(--color-accent)]" />
          <span className="font-medium text-[var(--color-text-primary)]">{t(language, 'toolforge.runtimeQualification')}</span>
          <span data-testid="generated-tools-qualification" className="rounded-full bg-[var(--color-accent)]/15 px-2.5 py-1 text-xs font-semibold text-[var(--color-accent)]">{snapshot.qualification.level}</span>
          <span className="text-xs text-[var(--color-text-muted)]">{t(language, 'toolforge.qualificationEnvironments', { dev: snapshot.qualification.devStatus, packaged: snapshot.qualification.packagedStatus })}</span>
          {snapshot.qualification.level === 'L1' && <span className="w-full text-xs text-amber-300">{t(language, 'toolforge.qualificationApprovalRequired')}</span>}
        </div>
      ) : !loading && !inventoryError ? (
        <div className="hidden" />
      ) : null}

      {promoteError && <div className="mb-4 rounded-lg border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-300">{promoteError}</div>}

      {continuationError && <div data-testid="generated-tools-continuation-error" className="mb-4 rounded-lg border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">{continuationError}</div>}

      {continuations.length > 0 && <div className="mb-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4" data-testid="generated-tools-continuations">
        <p className="text-sm font-semibold text-[var(--color-text-primary)]">{t(language, 'toolforge.continuations')}</p>
        <div className="mt-2 space-y-2">{continuations.slice(0, 5).map((continuation) => <div key={continuation.id} className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className="font-mono text-[var(--color-text-muted)]">{continuation.toolId} · {continuation.versionId}</span><span className="rounded bg-[var(--color-surface-active)] px-2 py-1 text-[var(--color-text-secondary)]">{t(language, `toolforge.continuation.${continuation.status}`)}</span></div>)}</div>
      </div>}

      {loading && !snapshot ? (
        <div data-testid="generated-tools-loading" className="grid gap-3 sm:grid-cols-2">
          {[0, 1, 2, 3].map((item) => <div key={item} className="h-36 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]" />)}
        </div>
      ) : inventoryError ? (
        <div data-testid="generated-tools-error" className="rounded-lg border border-red-400/20 bg-red-400/10 p-4 text-sm text-red-300">
          <div className="flex items-center gap-2 font-medium"><AlertTriangle size={16} /> {t(language, 'settings.generatedToolsLoadFailed')}</div>
          <p className="mt-2 text-red-300/80">{inventoryError}</p>
        </div>
      ) : !snapshot || snapshot.tools.length === 0 ? (
        <div data-testid="generated-tools-empty" className="rounded-xl border border-dashed border-[var(--color-border-light)] bg-[var(--color-bg)] px-6 py-12 text-center">
          <Boxes size={28} className="mx-auto text-[var(--color-text-muted)]" />
          <p className="mt-3 font-medium text-[var(--color-text-primary)]">{t(language, 'settings.generatedToolsEmpty')}</p>
          <p className="mx-auto mt-1 max-w-lg text-sm leading-6 text-[var(--color-text-muted)]">{t(language, 'settings.generatedToolsEmptyHint')}</p>
                <div className="mt-5 flex flex-wrap justify-center gap-3">
                  {onCreateInConversation && (
                    <button
                      type="button"
                      onClick={onCreateInConversation}
                      className="rounded-md bg-[var(--color-accent)]/15 px-4 py-2 text-sm font-semibold text-[var(--color-accent)] hover:bg-[var(--color-accent)]/25"
                    >
                      {t(language, 'toolforge.createInConversation')}
                    </button>
                  )}
                </div>
        </div>
      ) : (
        <div data-testid="generated-tools-inventory" className="grid gap-3 sm:grid-cols-2">
          {snapshot.tools.map((tool) => (
            <article
              key={tool.toolId}
              data-testid={`generated-tool-card-${tool.toolId}`}
              tabIndex={0}
              role="button"
              onClick={() => void openWorkbench(tool.toolId)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  void openWorkbench(tool.toolId)
                }
              }}
              className="group min-h-40 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4 text-left transition hover:-translate-y-0.5 hover:border-[var(--color-border-light)] hover:bg-[var(--color-surface-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-[var(--color-text-primary)]">{tool.displayName}</p>
                  <p className="mt-1 line-clamp-2 text-sm leading-5 text-[var(--color-text-muted)]">{tool.description}</p>
                </div>
                <span data-testid={`generated-tool-status-${tool.toolId}`} className={`shrink-0 rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide ${statusClass(tool)}`}>{t(language, `toolforge.status.${tool.availability}`)}</span>
              </div>
              {tool.executionPolicy === 'approval-required' && <p className="mt-3 text-xs text-amber-300">{t(language, 'toolforge.executionApprovalRequired')}</p>}
              {tool.executionPolicy === 'unavailable' && tool.availability === 'available' && <p className="mt-3 text-xs text-amber-300">{t(language, 'toolforge.executionUnavailable')}</p>}
              {tool.candidate && ['awaiting-policy', 'promoting'].includes(tool.candidate.status) && (
                <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
                  <span>{t(language, `toolforge.job.${tool.candidate.status}`)}</span>
                  <span className="font-mono">{tool.candidate.jobId}</span>
                </div>
              )}
              {tool.candidate && tool.candidate.status === 'awaiting-policy' && <p className="mt-2 text-xs text-amber-300">{t(language, 'toolforge.promotionFromWorkbench')}</p>}
              {tool.candidate && tool.candidate.status === 'awaiting-policy' && <button type="button" disabled={promoting} onClick={(event) => { event.stopPropagation(); void promoteCandidate(tool.toolId) }} className="mt-3 inline-flex min-h-8 items-center rounded-md bg-[var(--color-accent)]/15 px-3 text-xs font-semibold text-[var(--color-accent)] hover:bg-[var(--color-accent)]/25 disabled:opacity-50">{promoting ? t(language, 'toolforge.promoting') : t(language, 'toolforge.promote')}</button>}              {tool.candidate && (
                <div className="mt-3 flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                  <span>{t(language, 'toolforge.candidate')}</span>
                  <span className="rounded bg-[var(--color-surface-active)] px-2 py-0.5 text-[var(--color-text-secondary)]">{t(language, `toolforge.job.${tool.candidate.status}`)}</span>
                </div>
              )}
              <div className="mt-4 grid grid-cols-2 gap-3 border-t border-[var(--color-border)] pt-3 text-xs">
                <div><p className="text-[var(--color-text-muted)]">{t(language, 'toolforge.activeVersion')}</p><p className="mt-1 font-mono text-[var(--color-text-secondary)]">{tool.activeVersionId ?? '—'}</p></div>
                <div><p className="text-[var(--color-text-muted)]">{t(language, 'toolforge.invocations')}</p><p className="mt-1 tabular-nums text-[var(--color-text-secondary)]">{tool.invocationCount}</p></div>
              </div>
              <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-[var(--color-text-muted)]">
                <span>{t(language, 'toolforge.capabilityRevision')}: {tool.capabilityRevision ?? snapshot.capabilityRevision}</span>
                <span>{t(language, 'toolforge.pointerRevision')}: {tool.pointerRevision ?? '—'}</span>
              </div>
              <p className="mt-3 text-[11px] text-[var(--color-text-muted)]">{t(language, 'toolforge.lastActivity')}: {formatTime(tool.lastInvokedAt ?? tool.updatedAt, language)}</p>
            </article>
          ))}
        </div>
      )}

      {selectedToolId && (
        <ToolWorkbench
          language={language}
          toolId={selectedToolId}
          detail={detail}
          loading={detailLoading}
          error={detailError}
          initialFocus={initialFocus}
          editRequestedFrom={editRequestedFrom}
          onRetry={() => void openWorkbench(selectedToolId)}
          onLifecycleMutation={mutateLifecycle}
          onEditStarted={() => {
            void load()
            if (selectedToolId) void openWorkbench(selectedToolId)
          }}
          onClose={() => {
            detailRequestRef.current += 1
            setSelectedToolId(null)
            setDetail(null)
            setDetailError('')
            setDetailLoading(false)
          }}
        />
      )}
    </section>
  )
}
