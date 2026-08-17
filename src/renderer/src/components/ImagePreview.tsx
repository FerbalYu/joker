import { useEffect, useRef, useState } from 'react'
import { X, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react'
import type { ChatImagePart } from '@shared/types'
import { imagePreviewUrl } from '@shared/messages'
import { t, type Language } from '../i18n'

interface Props {
  image: ChatImagePart
  language: Language
  mode: 'thumbnail' | 'attachment'
  onRemove?: () => void
}

const LIGHTBOX_MIN_SCALE = 1
const LIGHTBOX_MAX_SCALE = 8

export default function ImagePreview({ image, language, mode, onRemove }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const wasOpenRef = useRef(false)
  const panStateRef = useRef<{ pointerId: number; startX: number; startY: number; baseX: number; baseY: number } | null>(null)
  const previewUrl = imagePreviewUrl(image)
  const alt = image.filename ?? t(language, 'input.imageAttachment')

  const resetView = (): void => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }

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
    if (open) resetView()
  }, [open])

  useEffect(() => {
    if (wasOpenRef.current && !open) triggerRef.current?.focus()
    wasOpenRef.current = open
  }, [open])

  const handleWheel = (event: React.WheelEvent): void => {
    if (!open) return
    event.stopPropagation()
    const factor = event.deltaY < 0 ? 1.2 : 1 / 1.2
    setScale((current) => {
      const next = Math.min(LIGHTBOX_MAX_SCALE, Math.max(LIGHTBOX_MIN_SCALE, current * factor))
      if (next === LIGHTBOX_MIN_SCALE) setOffset({ x: 0, y: 0 })
      return next
    })
  }

  const handlePointerDown = (event: React.PointerEvent): void => {
    if (scale <= 1) return
    event.currentTarget.setPointerCapture(event.pointerId)
    panStateRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, baseX: offset.x, baseY: offset.y }
  }

  const handlePointerMove = (event: React.PointerEvent): void => {
    const pan = panStateRef.current
    if (!pan || pan.pointerId !== event.pointerId) return
    setOffset({ x: pan.baseX + (event.clientX - pan.startX), y: pan.baseY + (event.clientY - pan.startY) })
  }

  const handlePointerUp = (event: React.PointerEvent): void => {
    if (panStateRef.current?.pointerId === event.pointerId) panStateRef.current = null
  }

  return (
    <>
      <div data-image-preview={mode} className="relative h-14 w-14 shrink-0 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen(true)}
          aria-label={t(language, 'input.previewImage')}
          title={t(language, 'input.previewImage')}
          className="h-full w-full cursor-zoom-in"
        >
          <img src={previewUrl} alt={alt} className="h-full w-full object-cover" />
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
          onWheel={handleWheel}
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
          <div className="absolute left-5 top-5 flex items-center gap-1.5" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              onClick={() => setScale((current) => Math.max(LIGHTBOX_MIN_SCALE, current / 1.4))}
              disabled={scale <= LIGHTBOX_MIN_SCALE}
              aria-label={t(language, 'input.zoomOut')}
              title={t(language, 'input.zoomOut')}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80 disabled:opacity-40"
            >
              <ZoomOut size={18} />
            </button>
            <span data-lightbox-scale className="min-w-12 text-center text-xs text-white/90">{Math.round(scale * 100)}%</span>
            <button
              type="button"
              onClick={() => setScale((current) => Math.min(LIGHTBOX_MAX_SCALE, current * 1.4))}
              disabled={scale >= LIGHTBOX_MAX_SCALE}
              aria-label={t(language, 'input.zoomIn')}
              title={t(language, 'input.zoomIn')}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80 disabled:opacity-40"
            >
              <ZoomIn size={18} />
            </button>
            <button
              type="button"
              onClick={resetView}
              aria-label={t(language, 'input.resetZoom')}
              title={t(language, 'input.resetZoom')}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
            >
              <Maximize2 size={16} />
            </button>
          </div>
          <img
            src={previewUrl}
            alt={alt}
            data-lightbox-image
            onClick={(event) => event.stopPropagation()}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`, cursor: scale > 1 ? 'grab' : 'zoom-in', transition: panStateRef.current ? 'none' : 'transform 120ms ease-out' }}
            className="max-h-[90vh] max-w-[90vw] select-none object-contain [touch-action:none]"
            draggable={false}
          />
        </div>
      )}
    </>
  )
}
