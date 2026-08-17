import { createPortal } from 'react-dom'
import { useStore } from '../store'
import { t } from '../i18n'
import { ImageIcon } from 'lucide-react'

/**
 * Full-viewport invitation shown while a file drag is over the window.
 * Decoration only: pointer-events none keeps drag targeting on the page
 * below, so the document-level listeners in App keep an accurate
 * enter/leave count and own accept/reject.
 */
export default function DropOverlay({ disabled }: { disabled: boolean }): React.JSX.Element {
  const language = useStore((s) => s.language)
  return createPortal(
    <div
      data-drop-overlay={disabled ? 'blocked' : 'active'}
      role="status"
      className="pointer-events-none fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-[2px]"
    >
      <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-[var(--color-accent)]/70 bg-[var(--color-surface)]/95 px-14 py-10 shadow-2xl">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--color-accent)]/15">
          <ImageIcon size={30} className={disabled ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-accent)]'} />
        </div>
        <p className="text-base font-medium text-[var(--color-text-primary)]">
          {t(language, disabled ? 'drop.blocked' : 'drop.title')}
        </p>
        {!disabled && (
          <p className="text-xs text-[var(--color-text-muted)]">{t(language, 'drop.desc')}</p>
        )}
      </div>
    </div>,
    document.body
  )
}
