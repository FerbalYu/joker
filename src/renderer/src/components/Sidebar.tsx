import type { SessionSummary } from '@shared/types'
import { useEffect, useState, type ReactNode } from 'react'
import {
  CircleCheck,
  CircleX,
  Loader2,
  MessageSquare,
  MessageSquareWarning,
  Plus,
  Settings,
  ShieldAlert,
  Trash2
} from 'lucide-react'
import logoUrl from '../../../image/logo.png'
import SettingsModal from './SettingsModal'
import { useStore } from '../store'
import { t } from '../i18n'
import { getSidebarSessionStatus, type SidebarSessionStatusView } from '../sidebar-session-status'

interface Props {
  onCreate: () => void
  onCreateInConversation?: () => void
  onSelect: (sessionId: string) => void
  onDelete: (sessionId: string) => void
  onRename: (sessionId: string, title: string) => void
}

const STATUS_TONE_CLASSES: Record<SidebarSessionStatusView['tone'], string> = {
  muted: 'text-[var(--color-text-muted)]',
  accent: 'text-[var(--color-accent)]',
  amber: 'text-amber-400',
  red: 'text-red-400',
  green: 'text-emerald-400'
}

function SessionStatusIcon({ status }: { status: SidebarSessionStatusView }): ReactNode {
  const className = `shrink-0 ${STATUS_TONE_CLASSES[status.tone]} ${status.spin ? 'animate-spin motion-reduce:animate-none' : ''}`

  switch (status.icon) {
    case 'shield-alert':
      return <ShieldAlert size={15} className={className} aria-hidden="true" />
    case 'loader':
      return <Loader2 size={15} className={className} aria-hidden="true" />
    case 'circle-x':
      return <CircleX size={15} className={className} aria-hidden="true" />
    case 'circle-check':
      return <CircleCheck size={15} className={className} aria-hidden="true" />
    case 'message-square-warning':
      return <MessageSquareWarning size={15} className={className} aria-hidden="true" />
    default:
      return <MessageSquare size={15} className={className} aria-hidden="true" />
  }
}

export default function Sidebar({ onCreate, onCreateInConversation, onSelect, onDelete, onRename }: Props): React.JSX.Element {
  const [showSettings, setShowSettings] = useState(false)
  const [settingsTab, setSettingsTab] = useState<'provider' | 'generated-tools'>('provider')
  const [selectedGeneratedToolId, setSelectedGeneratedToolId] = useState<string | null>(null)
  const [generatedToolFocus, setGeneratedToolFocus] = useState<'overview' | 'edit'>('overview')
  const [generatedToolRequestedFrom, setGeneratedToolRequestedFrom] = useState<'settings' | 'conversation'>('settings')
  const language = useStore((s) => s.language)
  const sessions = useStore((s) => s.sessions)
  const activeSessionId = useStore((s) => s.activeSessionId)
  const sessionLoading = useStore((s) => s.sessionLoading)
  const sessionError = useStore((s) => s.sessionError)

  const handleRename = (sessionId: string, title: string): void => {
    const nextTitle = window.prompt(t(language, 'sidebar.renameConversation'), title)
    if (nextTitle && nextTitle.trim() !== title) onRename(sessionId, nextTitle.trim())
  }

  useEffect(() => {
    const openGeneratedTool = (event: Event): void => {
      const detail = (event as CustomEvent<{
        toolId?: unknown
        focus?: unknown
        requestedFrom?: unknown
      }>).detail
      if (!detail || typeof detail.toolId !== 'string' || !detail.toolId.trim()) return
      setSettingsTab('generated-tools')
      setSelectedGeneratedToolId(detail.toolId)
      setGeneratedToolFocus(detail.focus === 'edit' ? 'edit' : 'overview')
      setGeneratedToolRequestedFrom(detail.requestedFrom === 'conversation' ? 'conversation' : 'settings')
      setShowSettings(true)
    }
    window.addEventListener('joker:open-generated-tool', openGeneratedTool)
    return () => window.removeEventListener('joker:open-generated-tool', openGeneratedTool)
  }, [])

  return (
    <>
      <aside className="flex w-60 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex items-center gap-2 px-4 py-4">
          <img src={logoUrl} alt="JOKER" className="h-8 w-8 rounded-md object-cover" />
          <span className="text-lg font-bold tracking-wider text-[var(--color-accent)]">JOKER</span>
        </div>
        <div className="px-3">
          <button onClick={onCreate} disabled={sessionLoading} className="flex w-full items-center gap-2 rounded-md border border-[var(--color-border-light)] px-3 py-2 text-sm text-[var(--color-text-primary)] transition hover:bg-[var(--color-surface-hover)] disabled:opacity-50">
            <Plus size={16} />
            {t(language, 'sidebar.newChat')}
          </button>
        </div>
        <div className="mt-4 flex-1 overflow-y-auto px-3">
          <p className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">{t(language, 'sidebar.today')}</p>
          {sessionError && <p className="px-2 py-2 text-xs text-red-400">{sessionError}</p>}
          {!sessionLoading && sessions.length === 0 && <p className="px-2 py-2 text-xs text-[var(--color-text-muted)]">{t(language, 'sidebar.newConversation')}</p>}
          <div className="space-y-1">
            {(sessions as SessionSummary[]).map((session) => {
              const status = getSidebarSessionStatus(session.activity)
              const statusLabel = t(language, status.labelKey, status.labelParams)
              const isActive = session.id === activeSessionId

              return (
                <div
                  key={session.id}
                  data-session-id={session.id}
                  data-session-status={status.dataStatus}
                  className={`group flex min-h-9 items-center gap-1 rounded-md px-2 text-sm ${isActive ? 'bg-[var(--color-surface-hover)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'}`}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(session.id)}
                    onDoubleClick={() => handleRename(session.id, session.title)}
                    aria-current={isActive ? 'page' : undefined}
                    aria-label={`${session.title} — ${statusLabel}`}
                    title={statusLabel}
                    className="flex min-h-9 min-w-0 flex-1 items-center gap-2 truncate text-left"
                  >
                    <SessionStatusIcon status={status} />
                    <span className={`truncate ${session.activity.unread ? 'font-medium text-[var(--color-text-primary)]' : ''}`}>{session.title}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(session.id)}
                    aria-label={t(language, 'sidebar.deleteConversation')}
                    title={t(language, 'sidebar.deleteConversation')}
                    className="pointer-events-none flex h-9 w-9 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-400 focus:pointer-events-auto focus:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--color-accent)] group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              )
            })}
          </div>
        </div>
        <div className="border-t border-[var(--color-border)] px-4 py-3">
          <button onClick={() => { setSettingsTab('provider'); setSelectedGeneratedToolId(null); setGeneratedToolFocus('overview'); setGeneratedToolRequestedFrom('settings'); setShowSettings(true) }} className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)] transition hover:text-[var(--color-text-primary)]">
            <Settings size={16} />
            {t(language, 'sidebar.settings')}
          </button>
        </div>
      </aside>
      {showSettings && <SettingsModal onCreateInConversation={() => {
        setShowSettings(false)
        setSelectedGeneratedToolId(null)
        setGeneratedToolFocus('overview')
        setGeneratedToolRequestedFrom('settings')
        onCreateInConversation?.()
      }} initialTab={settingsTab} initialGeneratedToolId={selectedGeneratedToolId ?? undefined} initialGeneratedToolFocus={generatedToolFocus} initialGeneratedToolRequestedFrom={generatedToolRequestedFrom} onClose={() => { setShowSettings(false); setSelectedGeneratedToolId(null); setGeneratedToolFocus('overview'); setGeneratedToolRequestedFrom('settings') }} />}
    </>
  )
}
