import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Boxes, PowerOff, RefreshCw } from 'lucide-react'

import type {
  GeneratedToolContinuationView,
  GeneratedToolDetail,
  GeneratedToolInventoryItem,
  GeneratedToolsInventorySnapshot
} from '@shared/types'
import { localizeError, t, type Language } from '../../i18n'
import ToolWorkbench from './ToolWorkbench'
import {
  generatedToolProductState,
  hasFailedGeneratedToolUpdate,
  isStaleGeneratedToolsCasError,
  shouldPollGeneratedTools,
  type GeneratedToolProductState
} from './generated-tools-settings-state'

interface Props {
  language: Language
  initialToolId?: string
  initialFocus?: 'overview' | 'edit'
  editRequestedFrom?: 'settings' | 'conversation'
  onCreateInConversation?: () => void
}

function statusClass(state: GeneratedToolProductState): string {
  if (state === 'enabled') return 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300'
  if (state === 'manufacturing') return 'border-sky-400/25 bg-sky-400/10 text-sky-300'
  if (state === 'waiting-permission') return 'border-amber-400/25 bg-amber-400/10 text-amber-300'
  if (state === 'validation-failed') return 'border-red-400/25 bg-red-400/10 text-red-300'
  return 'border-[var(--color-border-light)] bg-[var(--color-surface-active)] text-[var(--color-text-secondary)]'
}

function stableVersionId(item: GeneratedToolInventoryItem): string | undefined {
  return item.lastStableVersionId ?? item.activeVersionId
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
  const [enablingJobId, setEnablingJobId] = useState<string | null>(null)
  const [cardLifecycleToolId, setCardLifecycleToolId] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
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

  const polling = shouldPollGeneratedTools(snapshot, continuations)

  useEffect(() => {
    if (!polling) return
    const timer = window.setTimeout(() => { void load() }, 1_000)
    return () => window.clearTimeout(timer)
  }, [load, polling, snapshot, continuations])

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

  const enableCandidate = async (toolId: string, jobId: string): Promise<void> => {
    if (enablingJobId) return
    setEnablingJobId(jobId)
    setActionError('')
    try {
      const result = await window.joker.generatedTools.enable({ jobId })
      if (!mountedRef.current) return
      if (!result.success) {
        setActionError(localizeError(language, result.error.message))
        return
      }
      const nextSnapshot = await load()
      if (nextSnapshot?.tools.find((tool) => tool.toolId === toolId)?.activeVersionId && selectedToolId === toolId) {
        await openWorkbench(toolId)
      }
    } catch (enableFailure) {
      if (mountedRef.current) setActionError(localizeError(language, enableFailure instanceof Error ? enableFailure.message : String(enableFailure)))
    } finally {
      if (mountedRef.current) setEnablingJobId(null)
    }
  }

  const mutateInventoryCard = async (tool: GeneratedToolInventoryItem, action: 'disable' | 'reenable'): Promise<void> => {
    if (cardLifecycleToolId) return
    setCardLifecycleToolId(tool.toolId)
    setActionError('')
    const input = {
      toolId: tool.toolId,
      expectedRevision: snapshotRef.current?.registryRevision ?? 0,
      operationId: crypto.randomUUID()
    }
    try {
      const result = action === 'disable'
        ? await window.joker.generatedTools.disable(input)
        : await window.joker.generatedTools.reenable({ ...input, versionId: stableVersionId(tool) ?? '' })
      if (!result.success) throw new Error(localizeError(language, result.error ?? t(language, 'toolforge.lifecycleFailed')))
      await load()
    } catch (mutationError) {
      if (isStaleGeneratedToolsCasError(mutationError)) {
        await load()
      } else if (mountedRef.current) {
        setActionError(localizeError(language, mutationError instanceof Error ? mutationError.message : String(mutationError)))
      }
    } finally {
      if (mountedRef.current) setCardLifecycleToolId(null)
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
        <button type="button" onClick={() => { void load() }} disabled={loading} className="flex min-h-10 items-center gap-2 rounded-md border border-[var(--color-border)] px-3 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] disabled:opacity-40">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> {t(language, 'settings.generatedToolsRefresh')}
        </button>
      </div>

      {actionError && <div className="mb-4 rounded-lg border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-300">{actionError}</div>}

      {continuationError && <div data-testid="generated-tools-continuation-error" className="mb-4 rounded-lg border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">{continuationError}</div>}

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
          {snapshot.tools.map((tool) => {
            const productState = generatedToolProductState(tool)
            const failedUpdate = hasFailedGeneratedToolUpdate(tool)
            const cardBusy = cardLifecycleToolId === tool.toolId
            const waitingPermission = productState === 'waiting-permission' && tool.candidate
            return (
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
                <span data-testid={`generated-tool-status-${tool.toolId}`} className={`shrink-0 rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide ${statusClass(productState)}`}>{t(language, `toolforge.productState.${productState}`)}</span>
              </div>
              {failedUpdate && (
                <div className="mt-3 rounded-md border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs text-red-200">
                  <p className="font-semibold">{t(language, 'toolforge.failedUpdate')}</p>
                  <p className="mt-1 text-red-200/80">{t(language, 'toolforge.failedUpdateHint')}</p>
                </div>
              )}
              {waitingPermission && (
                <div className="mt-3 rounded-md border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
                  <p>{t(language, waitingPermission.requiresApproval ? 'toolforge.waitingPermissionHint' : 'toolforge.readyToEnableHint')}</p>
                  <button type="button" disabled={Boolean(enablingJobId)} onClick={(event) => { event.stopPropagation(); void enableCandidate(tool.toolId, waitingPermission.jobId) }} className="mt-2 inline-flex min-h-8 items-center rounded-md bg-amber-300/15 px-3 font-semibold hover:bg-amber-300/25 disabled:opacity-50">{enablingJobId === waitingPermission.jobId ? t(language, 'toolforge.enabling') : t(language, 'toolforge.enable')}</button>
                </div>
              )}
              {tool.executionPolicy === 'approval-required' && productState === 'enabled' && <p className="mt-3 text-xs text-amber-300">{t(language, 'toolforge.executionApprovalRequired')}</p>}
              {tool.issues.length > 0 && !failedUpdate && <p className="mt-3 text-xs text-red-300">{t(language, 'toolforge.problemsFound', { count: tool.issues.length })}</p>}
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border)] pt-3">
                <div className="text-xs text-[var(--color-text-muted)]">
                  {tool.permissionSummary.length > 0 ? t(language, 'toolforge.permissionCount', { count: tool.permissionSummary.length }) : t(language, 'toolforge.noExtraPermissions')}
                </div>
                <div className="flex gap-2">
                  {productState === 'enabled' && <button data-testid={`generated-tool-disable-${tool.toolId}`} type="button" onClick={(event) => { event.stopPropagation(); void mutateInventoryCard(tool, 'disable') }} disabled={cardBusy} className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-red-400/30 px-3 text-xs font-semibold text-red-300 hover:bg-red-400/10 disabled:opacity-50"><PowerOff size={13} /> {t(language, 'toolforge.disable')}</button>}
                  {productState === 'disabled' && stableVersionId(tool) && <button data-testid={`generated-tool-reenable-${tool.toolId}`} type="button" onClick={(event) => { event.stopPropagation(); void mutateInventoryCard(tool, 'reenable') }} disabled={cardBusy} className="inline-flex min-h-8 items-center gap-1.5 rounded-md bg-[var(--color-accent)]/15 px-3 text-xs font-semibold text-[var(--color-accent)] hover:bg-[var(--color-accent)]/25 disabled:opacity-50"><RefreshCw size={13} /> {t(language, 'toolforge.reenable')}</button>}
                </div>
              </div>
            </article>
            )
          })}
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
