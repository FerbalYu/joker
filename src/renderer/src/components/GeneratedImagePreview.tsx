import { useEffect, useRef, useState } from 'react'
import { ExternalLink, X } from 'lucide-react'
import type { GeneratedImageRef } from '@shared/types'
import { useStore } from '../store'
import { t, localizeError } from '../i18n'

interface Props {
  image: GeneratedImageRef
}

export default function GeneratedImagePreview({ image }: Props): React.JSX.Element {
  const language = useStore((state) => state.language)
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let active = true
    setUrl(null)
    setError(null)
    void window.joker.generatedImage.read(image)
      .then((result) => {
        if (!active) return
        if (!result.success || !result.data || !result.mediaType) {
          setError(localizeError(language, result.error ?? t(language, 'image.generatedLoadFailed')))
          return
        }
        setUrl(`data:${result.mediaType};base64,${result.data}`)
      })
      .catch((readError: unknown) => {
        if (!active) return
        setError(localizeError(language, readError instanceof Error ? readError.message : t(language, 'image.generatedLoadFailed')))
      })
    return () => { active = false }
  }, [image, language])

  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open])

  if (error) return <p className="rounded bg-red-500/10 px-2 py-1 text-xs text-red-400">{error}</p>
  if (!url) return <div className="h-36 animate-pulse rounded-md bg-[var(--color-bg)]" />

  return (
    <>
      <div className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
        <button type="button" onClick={() => setOpen(true)} className="block w-full cursor-zoom-in">
          <img src={url} alt={image.filename} className="max-h-72 w-full object-contain" />
        </button>
        <div className="flex items-center justify-between gap-2 border-t border-[var(--color-border)] px-2 py-1.5">
          <span className="min-w-0 truncate text-[10px] text-[var(--color-text-muted)]">{image.filename}</span>
          <button type="button" onClick={() => void window.joker.generatedImage.reveal(image)} title={t(language, 'image.reveal')} aria-label={t(language, 'image.reveal')} className="shrink-0 rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-accent)]"><ExternalLink size={13} /></button>
        </div>
      </div>
      {open && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-6" onClick={() => setOpen(false)}>
          <button ref={closeRef} type="button" onClick={() => setOpen(false)} className="absolute right-5 top-5 flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"><X size={20} /></button>
          <img src={url} alt={image.filename} onClick={(event) => event.stopPropagation()} className="max-h-[90vh] max-w-[90vw] object-contain" />
        </div>
      )}
    </>
  )
}
