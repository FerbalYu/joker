import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Clock3, Code2, FileJson2, History, PowerOff, RefreshCw, Shield, Trash2, X, XCircle } from 'lucide-react'

import type {
  GeneratedToolDetail,
  GeneratedToolPermissionManifest,
  GeneratedToolValidationCheckView
} from '@shared/types'
import { t, type Language } from '../../i18n'
import { generatedToolProductState, hasFailedGeneratedToolUpdate } from './generated-tools-settings-state'

interface Props {
  language: Language
  toolId: string
  detail: GeneratedToolDetail | null
  loading: boolean
  error: string
  initialFocus?: 'overview' | 'edit'
  editRequestedFrom?: 'settings' | 'conversation'
  onRetry: () => void
  onClose: () => void
  onLifecycleMutation: (action: 'disable' | 'reenable' | 'rollback' | 'revalidate' | 'remove', versionId?: string) => Promise<void>
  onEditStarted?: () => void
}

function formatTime(value: number | undefined, language: Language): string {
  return value === undefined ? '—' : new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'medium'
  }).format(value)
}

function permissionRows(permissions: GeneratedToolPermissionManifest): Array<[string, string[]]> {
  return [
    ['filesystem.read', permissions.filesystem.read],
    ['filesystem.write', permissions.filesystem.write],
    ['network', permissions.network.hosts],
    ['process', permissions.process.commands],
    ['environment', permissions.environment.keys],
    ['secrets', permissions.secrets.handles]
  ]
}

function CheckIcon({ check }: { check: GeneratedToolValidationCheckView }): React.JSX.Element {
  if (check.status === 'passed') return <CheckCircle2 size={15} className="text-emerald-400" />
  if (check.status === 'failed') return <XCircle size={15} className="text-red-400" />
  return <Clock3 size={15} className="text-amber-400" />
}

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <header className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-3">
        <span className="text-[var(--color-accent)]">{icon}</span>
        <h3 className="font-semibold text-[var(--color-text-primary)]">{title}</h3>
      </header>
      <div className="p-4">{children}</div>
    </section>
  )
}

function DiagnosticSection({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return (
    <details className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]">
        <span className="text-[var(--color-accent)]">{icon}</span>
        <span className="font-semibold">{title}</span>
      </summary>
      <div className="border-t border-[var(--color-border)] p-4">{children}</div>
    </details>
  )
}

export default function ToolWorkbench({
  language,
  toolId,
  detail,
  loading,
  error,
  initialFocus = 'overview',
  editRequestedFrom = 'settings',
  onRetry,
  onClose,
  onLifecycleMutation,
  onEditStarted
}: Props): React.JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const editRef = useRef<HTMLTextAreaElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (initialFocus !== 'edit') closeRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? [])]
        .filter((element) => !element.hasAttribute('hidden'))
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      returnFocusRef.current?.focus()
    }
  }, [])

  const [editInstruction, setEditInstruction] = useState('')
  const [editing, setEditing] = useState(false)
  const [editMessage, setEditMessage] = useState('')
  const [lifecycleBusy, setLifecycleBusy] = useState(false)
  const [lifecycleMessage, setLifecycleMessage] = useState('')
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const activeVersion = detail?.versions.find((version) => version.active)
    ?? detail?.versions.find((version) => version.stable)
  const report = activeVersion?.validationReport
  const productState = detail ? generatedToolProductState(detail.summary) : null
  const failedUpdate = detail ? hasFailedGeneratedToolUpdate(detail.summary) : false

  useEffect(() => {
    if (initialFocus === 'edit' && detail && !loading && !error) editRef.current?.focus()
  }, [detail, error, initialFocus, loading])

  const runLifecycleMutation = async (action: 'disable' | 'reenable' | 'rollback' | 'revalidate' | 'remove', versionId?: string): Promise<void> => {
    setLifecycleBusy(true)
    setLifecycleMessage('')
    try {
      await onLifecycleMutation(action, versionId)
      setLifecycleMessage(t(language, 'toolforge.lifecycleSucceeded'))
    } catch (mutationError) {
      setLifecycleMessage(`${t(language, 'toolforge.lifecycleFailed')}: ${mutationError instanceof Error ? mutationError.message : String(mutationError)}`)
    } finally {
      setLifecycleBusy(false)
    }
  }

  const submitEdit = async (): Promise<void> => {
    if (!activeVersion || !editInstruction.trim()) return
    setEditing(true)
    setEditMessage('')
    try {
      const result = await window.joker.generatedTools.edit({
        toolId,
        baseVersionId: activeVersion.id,
        baseFingerprint: activeVersion.fingerprint,
        instruction: editInstruction.trim(),
        requestedFrom: editRequestedFrom
      })
      setEditMessage(result.success ? t(language, 'toolforge.editStarted') : `${t(language, 'toolforge.editFailed')}: ${result.error.message}`)
      if (result.success) {
        setEditInstruction('')
        onEditStarted?.()
      }
    } catch (error) {
      setEditMessage(`${t(language, 'toolforge.editFailed')}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setEditing(false)
    }
  }

  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="tool-workbench-title" data-testid="tool-workbench" className="tool-workbench fixed inset-0 z-[90] flex flex-col bg-[var(--color-bg)]">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4 sm:px-7">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-[var(--color-accent)]">{t(language, 'toolforge.workbench')}</p>
          <h2 id="tool-workbench-title" className="mt-1 truncate text-xl font-bold text-[var(--color-text-primary)]">{detail?.summary.displayName ?? toolId}</h2>
        </div>
        <button ref={closeRef} type="button" onClick={onClose} aria-label={t(language, 'toolforge.closeWorkbench')} className="flex h-10 w-10 items-center justify-center rounded-full border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"><X size={19} /></button>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7">
        {loading ? (
          <div data-testid="tool-workbench-loading" className="mx-auto grid max-w-6xl gap-4 lg:grid-cols-2">
            {[0, 1, 2, 3, 4, 5].map((item) => <div key={item} className="h-48 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]" />)}
          </div>
        ) : error ? (
          <div data-testid="tool-workbench-error" className="mx-auto mt-12 max-w-xl rounded-xl border border-red-400/20 bg-red-400/10 p-6 text-center">
            <AlertTriangle size={25} className="mx-auto text-red-400" />
            <h3 className="mt-3 font-semibold text-red-300">{t(language, 'toolforge.detailLoadFailed')}</h3>
            <p className="mt-2 text-sm leading-6 text-red-300/80">{error}</p>
            <button type="button" onClick={onRetry} className="mt-4 inline-flex min-h-10 items-center gap-2 rounded-md bg-red-400/15 px-4 text-sm text-red-200 hover:bg-red-400/25"><RefreshCw size={14} /> {t(language, 'toolforge.retry')}</button>
          </div>
        ) : !detail ? (
          <div data-testid="tool-workbench-missing" className="mx-auto mt-12 max-w-xl rounded-xl border border-amber-400/20 bg-amber-400/10 p-6 text-center text-amber-200">{t(language, 'toolforge.deleted')}</div>
        ) : (
          <div className="mx-auto grid max-w-7xl gap-4 lg:grid-cols-2">
            <Section title={t(language, 'toolforge.statusAndControls')} icon={<Shield size={17} />}>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-xs text-[var(--color-text-muted)]">{t(language, 'toolforge.status')}</p>
                  <p data-testid="tool-workbench-status" className="mt-1 font-medium text-[var(--color-text-primary)]">{productState ? t(language, `toolforge.productState.${productState}`) : '—'}</p>
                  {failedUpdate && <p className="mt-2 text-xs text-red-300">{t(language, 'toolforge.failedUpdateHint')}</p>}
                </div>
                <div className="flex flex-wrap gap-2">
                  {productState !== 'disabled' && activeVersion && <button data-testid="tool-workbench-disable" type="button" onClick={() => void runLifecycleMutation('disable')} disabled={lifecycleBusy} className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-red-400/30 px-3 text-xs font-semibold text-red-300 hover:bg-red-400/10 disabled:opacity-50"><PowerOff size={14} /> {t(language, 'toolforge.disable')}</button>}
                  {productState === 'disabled' && detail.summary.lastStableVersionId && <button data-testid="tool-workbench-reenable" type="button" onClick={() => void runLifecycleMutation('reenable', detail.summary.lastStableVersionId)} disabled={lifecycleBusy} className="inline-flex min-h-9 items-center gap-1.5 rounded-md bg-[var(--color-accent)]/15 px-3 text-xs font-semibold text-[var(--color-accent)] hover:bg-[var(--color-accent)]/25 disabled:opacity-50"><RefreshCw size={14} /> {t(language, 'toolforge.reenable')}</button>}
                  {productState === 'disabled' && !confirmingRemove && <button data-testid="tool-workbench-remove" type="button" onClick={() => setConfirmingRemove(true)} disabled={lifecycleBusy} className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-red-400/30 px-3 text-xs font-semibold text-red-300 hover:bg-red-400/10 disabled:opacity-50"><Trash2 size={14} /> {t(language, 'toolforge.remove')}</button>}
                </div>
              </div>
              {productState === 'disabled' && confirmingRemove && <div data-testid="tool-workbench-remove-confirmation" className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-red-400/30 bg-red-400/10 p-2 text-xs text-red-200"><span>{t(language, 'toolforge.removeConfirm')}</span><button data-testid="tool-workbench-remove-confirm" type="button" onClick={() => void runLifecycleMutation('remove')} disabled={lifecycleBusy} className="min-h-8 rounded-md bg-red-400/20 px-3 font-semibold hover:bg-red-400/30 disabled:opacity-50">{t(language, 'toolforge.removeConfirmAction')}</button><button data-testid="tool-workbench-remove-cancel" type="button" onClick={() => setConfirmingRemove(false)} disabled={lifecycleBusy} className="min-h-8 rounded-md border border-[var(--color-border-light)] px-3 font-semibold text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-50">{t(language, 'toolforge.removeCancel')}</button></div>}
              {lifecycleMessage && <p className="mt-3 text-xs text-[var(--color-text-secondary)]">{lifecycleMessage}</p>}
            </Section>

            <Section title={t(language, 'toolforge.permissions')} icon={<Shield size={17} />}>
              {activeVersion ? <div className="space-y-2">{permissionRows(activeVersion.manifest.permissions).map(([name, values]) => (
                <div key={name} className="grid grid-cols-[9rem_minmax(0,1fr)] gap-3 rounded-md bg-[var(--color-bg)] px-3 py-2 text-xs">
                  <span className="font-mono text-[var(--color-text-muted)]">{name}</span>
                  <span className={values.length > 0 ? 'break-all text-[var(--color-text-secondary)]' : 'text-emerald-400'}>{values.length > 0 ? values.join(', ') : t(language, 'toolforge.noneDeclared')}</span>
                </div>
              ))}</div> : <p className="text-sm text-[var(--color-text-muted)]">{t(language, 'toolforge.versionUnavailable')}</p>}
            </Section>

            <Section title={t(language, 'toolforge.modify')} icon={<Code2 size={17} />}>
              <label className="block text-xs text-[var(--color-text-muted)]" htmlFor="toolforge-edit-instruction">{t(language, 'toolforge.editInstruction')}</label>
              <textarea ref={editRef} data-testid="tool-workbench-edit-instruction" id="toolforge-edit-instruction" value={editInstruction} onChange={(event) => setEditInstruction(event.target.value)} placeholder={t(language, 'toolforge.editPlaceholder')} disabled={!activeVersion || editing} className="mt-2 min-h-20 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-sm text-[var(--color-text-primary)]" />
              <button data-testid="tool-workbench-edit-submit" type="button" onClick={() => void submitEdit()} disabled={!activeVersion || !editInstruction.trim() || editing} className="mt-2 inline-flex min-h-9 items-center rounded-md bg-[var(--color-accent)]/15 px-3 text-xs font-semibold text-[var(--color-accent)] disabled:opacity-50">{editing ? t(language, 'toolforge.editSubmitting') : t(language, 'toolforge.editSubmit')}</button>
              {editMessage && <p data-testid="tool-workbench-edit-message" className="mt-2 text-xs text-[var(--color-text-secondary)]">{editMessage}</p>}
            </Section>

            <Section title={t(language, 'toolforge.problems')} icon={<AlertTriangle size={17} />}>
              {detail.summary.issues.length === 0 && !failedUpdate ? <p className="text-sm text-emerald-400">{t(language, 'toolforge.noProblems')}</p> : <div className="space-y-2">{failedUpdate && <p className="rounded-md bg-red-400/10 px-3 py-2 text-sm text-red-300">{t(language, 'toolforge.failedUpdateHint')}</p>}{detail.summary.issues.map((issue) => <p key={issue.code} className="rounded-md bg-red-400/10 px-3 py-2 text-sm text-red-300">{issue.message}</p>)}</div>}
            </Section>

            <details className="lg:col-span-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
              <summary className="cursor-pointer px-4 py-3 font-semibold text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]">{t(language, 'toolforge.advancedDiagnostics')}</summary>
              <div className="grid gap-4 border-t border-[var(--color-border)] p-4 lg:grid-cols-2">
            <DiagnosticSection title={t(language, 'toolforge.inputOutput')} icon={<FileJson2 size={17} />}>
              {activeVersion ? <div className="grid gap-3 xl:grid-cols-2">
                <div><p className="mb-2 text-xs font-medium text-[var(--color-text-muted)]">{t(language, 'toolforge.inputSchema')}</p><pre className="max-h-72 overflow-auto rounded-md bg-[var(--color-bg)] p-3 text-xs leading-5 text-[var(--color-text-secondary)]">{JSON.stringify(activeVersion.manifest.inputSchema, null, 2)}</pre></div>
                <div><p className="mb-2 text-xs font-medium text-[var(--color-text-muted)]">{t(language, 'toolforge.outputSchema')}</p><pre className="max-h-72 overflow-auto rounded-md bg-[var(--color-bg)] p-3 text-xs leading-5 text-[var(--color-text-secondary)]">{JSON.stringify(activeVersion.manifest.outputSchema, null, 2)}</pre></div>
              </div> : <p className="text-sm text-[var(--color-text-muted)]">{t(language, 'toolforge.versionUnavailable')}</p>}
            </DiagnosticSection>

            <DiagnosticSection title={t(language, 'toolforge.validation')} icon={<Code2 size={17} />}>
              {report ? <div>
                <div className="mb-3 flex flex-wrap items-center gap-2 text-xs"><span className="rounded-full bg-emerald-400/10 px-2 py-1 font-semibold text-emerald-300">{t(language, `toolforge.validation.${report.status}`)}</span><span className="text-[var(--color-text-muted)]">{formatTime(report.finishedAt, language)}</span></div>
                <div data-testid="tool-workbench-validation-checks" className="space-y-2">{report.checks.map((check) => <div key={check.id} className="flex items-start gap-3 rounded-md bg-[var(--color-bg)] px-3 py-2 text-xs"><CheckIcon check={check} /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium text-[var(--color-text-primary)]">{check.category}</p><span data-validation-evidence={check.hasEvidence ? 'retained' : 'missing'} className={check.hasEvidence ? 'rounded-full bg-sky-400/10 px-2 py-0.5 text-[10px] font-medium text-sky-300' : 'rounded-full bg-amber-400/10 px-2 py-0.5 text-[10px] font-medium text-amber-300'}>{t(language, check.hasEvidence ? 'toolforge.evidenceRetained' : 'toolforge.evidenceUnavailable')}</span></div><p className="mt-0.5 text-[var(--color-text-muted)]">{check.message}</p></div></div>)}</div>
              </div> : <p className="text-sm text-[var(--color-text-muted)]">{t(language, 'toolforge.validationUnavailable')}</p>}
            </DiagnosticSection>

            <DiagnosticSection title={t(language, 'toolforge.versions')} icon={<History size={17} />}>
              <div data-testid="tool-workbench-versions" className="space-y-2">{detail.versions.length === 0 ? <p className="text-sm text-[var(--color-text-muted)]">{t(language, 'toolforge.noVersions')}</p> : detail.versions.map((version) => <div key={version.id} className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs"><div className="flex items-center justify-between gap-3"><span className="font-mono font-semibold text-[var(--color-text-primary)]">{version.id}</span><div className="flex gap-1">{version.active && <span className="rounded bg-[var(--color-accent)]/15 px-2 py-0.5 text-[var(--color-accent)]">{t(language, 'toolforge.active')}</span>}{version.stable && <span className="rounded bg-sky-400/10 px-2 py-0.5 text-sky-300">{t(language, 'toolforge.stable')}</span>}</div></div><p className="mt-2 truncate font-mono text-[var(--color-text-muted)]" title={version.fingerprint}>{version.fingerprint}</p><p className="mt-1 text-[var(--color-text-muted)]">{formatTime(version.createdAt, language)}</p>{version.editDiff && <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-[var(--color-text-muted)]"><span>{t(language, 'toolforge.sourceChanged')}: {version.editDiff.sourceChanged ? t(language, 'toolforge.yes') : t(language, 'toolforge.no')}</span><span className={version.editDiff.permissions.expanded ? 'text-amber-300' : ''}>{t(language, 'toolforge.permissionExpansion')}: {version.editDiff.permissions.expanded ? t(language, 'toolforge.warning') : t(language, 'toolforge.no')}</span></div>}</div>)}</div>
            </DiagnosticSection>

            <DiagnosticSection title={t(language, 'toolforge.invocationHistory')} icon={<History size={17} />}>
              <div data-testid="tool-workbench-invocations" className="space-y-2">{detail.recentInvocations.length === 0 ? <p className="text-sm text-[var(--color-text-muted)]">{t(language, 'toolforge.noInvocations')}</p> : detail.recentInvocations.map((invocation) => <div key={invocation.id} className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs"><div className="flex items-center justify-between gap-3"><span className="font-mono text-[var(--color-text-secondary)]">{invocation.versionId}</span><span className={invocation.outcome === 'succeeded' ? 'text-emerald-400' : invocation.outcome ? 'text-red-300' : 'text-[var(--color-text-muted)]'}>{invocation.outcome ? t(language, `toolforge.outcome.${invocation.outcome}`) : t(language, `toolforge.invocation.${invocation.status}`)}</span></div><p className="mt-2 text-[var(--color-text-muted)]">{formatTime(invocation.finishedAt ?? invocation.startedAt ?? invocation.proposedAt, language)}</p>{invocation.error && <p className="mt-2 text-red-300">{invocation.error}</p>}</div>)}</div>
            </DiagnosticSection>
              </div>
            </details>
          </div>
        )}
      </main>
    </div>
  )
}
