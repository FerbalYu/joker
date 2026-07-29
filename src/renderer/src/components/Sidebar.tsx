import { useState } from 'react'
import { Plus, Settings, MessageSquare, Trash2 } from 'lucide-react'
import logoUrl from '../../../image/logo.png'
import SettingsModal from './SettingsModal'
import { useStore } from '../store'
import { t } from '../i18n'

interface Props {
  onCreate: () => void
  onSelect: (sessionId: string) => void
  onDelete: (sessionId: string) => void
  onRename: (sessionId: string, title: string) => void
}

export default function Sidebar({ onCreate, onSelect, onDelete, onRename }: Props): React.JSX.Element {
  const [showSettings, setShowSettings] = useState(false)
  const language = useStore((s) => s.language)
  const sessions = useStore((s) => s.sessions)
  const activeSessionId = useStore((s) => s.activeSessionId)
  const sessionLoading = useStore((s) => s.sessionLoading)
  const sessionError = useStore((s) => s.sessionError)

  const handleRename = (sessionId: string, title: string): void => {
    const nextTitle = window.prompt(language === 'zh' ? '重命名会话' : 'Rename conversation', title)
    if (nextTitle && nextTitle.trim() !== title) onRename(sessionId, nextTitle)
  }

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
            {sessions.map((session) => (
              <div key={session.id} className={`group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm ${session.id === activeSessionId ? 'bg-[var(--color-surface-hover)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'}`}>
                <button onClick={() => onSelect(session.id)} onDoubleClick={() => handleRename(session.id, session.title)} className="flex min-w-0 flex-1 items-center gap-2 truncate text-left">
                  <MessageSquare size={14} className="shrink-0 text-[var(--color-text-muted)]" />
                  <span className="truncate">{session.title}</span>
                </button>
                <button onClick={() => onDelete(session.id)} aria-label={language === 'zh' ? '删除会话' : 'Delete conversation'} className="invisible rounded p-1 text-[var(--color-text-muted)] hover:bg-red-500/10 hover:text-red-400 group-hover:visible">
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>
        <div className="border-t border-[var(--color-border)] px-4 py-3">
          <button onClick={() => setShowSettings(true)} className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)] transition hover:text-[var(--color-text-primary)]">
            <Settings size={16} />
            {t(language, 'sidebar.settings')}
          </button>
        </div>
      </aside>
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </>
  )
}
