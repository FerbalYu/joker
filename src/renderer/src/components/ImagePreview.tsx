import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { ChatImagePart } from '@shared/types'
import { imagePreviewUrl } from '@shared/messages'
import { t, type Language } from '../i18n'

interface Props {
  image: ChatImagePart
  language: Language
  mode: 'thumbnail' | 'message'
  onRemove?: () => void
}

export default function ImagePreview({ image, language, mode, onRemove }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const wasOpenRef = useRef(false)
  const previewUrl = imagePreviewUrl(image)
  const alt = image.filename ?? t(language, 'input.imageAttachment')

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    closeButtonRef.current?.focus()
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open])

  useEffect(() => {
    if (wasOpenRef.current && !open) triggerRef.current?.focus()
    wasOpenRef.current = open
  }, [open])

  return (
    <>
      <div className={mode === 'thumbnail'
        ? 'relative h-14 w-14 shrink-0 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]'
        : 'block max-h-80 max-w-full overflow-hidden rounded-lg border border-[var(--color-border)]'}
      >
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen(true)}
          aria-label={t(language, 'input.previewImage')}
          title={t(language, 'input.previewImage')}
          className={mode === 'thumbnail' ? 'h-full w-full cursor-zoom-in' : 'block max-h-80 max-w-full cursor-zoom-in'}
        >
          <img src={previewUrl} alt={alt} className={mode === 'thumbnail' ? 'h-full w-full object-cover' : 'max-h-80 max-w-full object-contain'} />
        </button>
        {mode === 'thumbnail' && onRemove && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              onRemove()
            }}
            aria-label={t(language, 'input.removeImage')}
            title={t(language, 'input.removeImage')}
            className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/70 text-white hover:bg-red-600"
          >
            <X size={10} />
          </button>
        )}
      </div>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t(language, 'input.imagePreview')}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-6"
          onClick={() => setOpen(false)}
        >
          <button
            ref={closeButtonRef}
            type="button"
            onClick={() => setOpen(false)}
            aria-label={t(language, 'input.closePreview')}
            title={t(language, 'input.closePreview')}
            className="absolute right-5 top-5 flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
          >
            <X size={20} />
          </button>
          <img
            src={previewUrl}
            alt={alt}
            onClick={(event) => event.stopPropagation()}
            className="max-h-[90vh] max-w-[90vw] object-contain"
          />
        </div>
      )}
    </>
  )
}
