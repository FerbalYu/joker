import { useState } from 'react'
import { PanelRightClose, PanelRightOpen, ShieldAlert } from 'lucide-react'
import { useStore } from '../store'
import { t } from '../i18n'
import ApprovalPanel from './ApprovalPanel'
import ToolCallList from './ToolCallList'

export default function DetailPanel(): React.JSX.Element {
  const approvalQueue = useStore((s) => s.approvalQueue)
  const selectedApproval = useStore((s) => s.selectedApproval)
  const pendingToolCalls = useStore((s) => s.pendingToolCalls)
  const activeSessionId = useStore((s) => s.activeSessionId)
  const sessions = useStore((s) => s.sessions)
  const streaming = useStore((s) => s.streaming)
  const contextUsage = useStore((s) => s.contextUsage)
  const streamProviderName = useStore((s) => s.streamProviderName)
  const streamModelName = useStore((s) => s.streamModelName)
  const language = useStore((s) => s.language)
  const [collapsed, setCollapsed] = useState(false)
  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const activeApprovals = approvalQueue.filter((approval) => approval.sessionId === activeSessionId)
  const activePendingToolCalls = activeSessionId ? pendingToolCalls : []
  const activeSelectedApproval = selectedApproval?.sessionId === activeSessionId ? selectedApproval : null

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
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--color-border)]"><div className="h-1.5 rounded-full bg-[var(--color-accent)]" style={{ width: `${Math.min(100, contextUsage.percent)}%` }} /></div>
            <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">{contextUsage.inputTokens.toLocaleString()} / {contextUsage.maxTokens.toLocaleString()} tokens</p>
          </section>}

          {activePendingToolCalls.length > 0 && <section>
            <p className="mb-2 text-xs uppercase tracking-widest text-[var(--color-text-muted)]">{t(language, 'detail.tools')}</p>
            <ToolCallList toolCalls={activePendingToolCalls} />
          </section>}

          {activeApprovals.length === 0 && activePendingToolCalls.length === 0 && !contextUsage && <p className="text-sm text-[var(--color-text-muted)]">{t(language, 'detail.empty')}</p>}

          {activeSelectedApproval && <section className="border-t border-[var(--color-border)] pt-4">
            <p className="mb-2 text-xs uppercase tracking-widest text-[var(--color-text-muted)]">{t(language, 'detail.approval')}</p>
            <ApprovalPanel key={activeSelectedApproval.requestId} approval={activeSelectedApproval} />
          </section>}
        </div>}
      </div>}
    </aside>
  )
}
