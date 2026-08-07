import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { ChatMessage } from '@shared/types'
import {
  buildMinimapEntries,
  calculateViewportIndicator,
  minimapClickToScrollTop,
  truncatePreview,
  type ViewportIndicator
} from '../message-minimap'

interface Props {
  messages: ChatMessage[]
  streamText: string
  streaming: boolean
  scrollRef: RefObject<HTMLDivElement | null>
}

export default function MessageMinimap({ messages, streamText, streaming, scrollRef }: Props): React.JSX.Element | null {
  const trackRef = useRef<HTMLDivElement>(null)
  const latestStreamTextRef = useRef(streamText)
  const [trackHeight, setTrackHeight] = useState(0)
  const [previewStreamText, setPreviewStreamText] = useState(streamText)
  const [indicator, setIndicator] = useState<ViewportIndicator>({ top: 0, height: 0 })
  const entries = useMemo(
    () => buildMinimapEntries(messages, previewStreamText, streaming, trackHeight),
    [messages, previewStreamText, streaming, trackHeight]
  )

  useEffect(() => {
    latestStreamTextRef.current = streamText
  }, [streamText])

  useEffect(() => {
    if (!streaming) {
      setPreviewStreamText('')
      return
    }
    setPreviewStreamText(latestStreamTextRef.current)
    const timer = window.setInterval(() => {
      setPreviewStreamText((current) => current === latestStreamTextRef.current ? current : latestStreamTextRef.current)
    }, 160)
    return () => window.clearInterval(timer)
  }, [streaming])

  useEffect(() => {
    const scrollElement = scrollRef.current
    const trackElement = trackRef.current
    if (!scrollElement || !trackElement) return

    let frame = 0
    const update = (): void => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        const height = trackElement.clientHeight
        setTrackHeight(height)
        setIndicator(calculateViewportIndicator(
          scrollElement.scrollTop,
          scrollElement.scrollHeight,
          scrollElement.clientHeight,
          height
        ))
      })
    }

    const observer = new ResizeObserver(update)
    observer.observe(scrollElement)
    observer.observe(trackElement)
    const contentElement = scrollElement.querySelector('[data-message-stream-content]')
    if (contentElement) observer.observe(contentElement)
    scrollElement.addEventListener('scroll', update, { passive: true })
    update()

    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      scrollElement.removeEventListener('scroll', update)
    }
  }, [scrollRef])

  if (entries.length === 0) return null

  const scrollFromPointer = (clientY: number): void => {
    const scrollElement = scrollRef.current
    const trackElement = trackRef.current
    if (!scrollElement || !trackElement) return
    const rect = trackElement.getBoundingClientRect()
    scrollElement.scrollTop = minimapClickToScrollTop(
      clientY - rect.top,
      rect.height,
      indicator.height,
      scrollElement.scrollHeight,
      scrollElement.clientHeight
    )
  }

  return (
    <aside className="sticky top-0 h-full w-[52px] shrink-0 self-start border-r border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-5">
      <div
        ref={trackRef}
        aria-label="对话缩略导航"
        className="relative h-full w-full"
        onClick={(event) => scrollFromPointer(event.clientY)}
      >
        {entries.map((entry) => {
          const userPreview = truncatePreview(entry.userPreview)
          const replyPreview = truncatePreview(entry.replyPreview)
          return (
            <button
            key={entry.id}
            type="button"
            aria-label={`我说的：${userPreview}；返回：${replyPreview || '暂无返回'}`}
            onClick={(event) => {
              event.stopPropagation()
              scrollFromPointer(event.clientY)
            }}
            className="group absolute left-0 z-10 h-10 w-10 -translate-y-1/2 text-left focus:outline-none"
            style={{ top: `${entry.top + entry.height / 2}px` }}
          >
            <span className="absolute left-0 top-1/2 block h-px w-2.5 -translate-y-1/2 bg-[var(--color-text-muted)]/75 transition-[width,background-color] duration-150 group-hover:w-7 group-hover:bg-white group-focus-visible:w-7 group-focus-visible:bg-white" />
            <span className="pointer-events-none absolute left-9 top-1/2 z-30 hidden w-64 -translate-y-1/2 rounded-lg border border-[var(--color-border-light)] bg-[var(--color-surface)] px-3 py-2 text-xs leading-5 text-[var(--color-text-secondary)] shadow-2xl group-hover:block group-focus-visible:block">
              <span className="block break-words"><span className="text-[var(--color-text-primary)]">我说的：</span>{userPreview || '（空）'}</span>
              <span className="block break-words"><span className="text-[var(--color-text-primary)]">返回：</span>{replyPreview || '暂无返回'}</span>
            </span>
            </button>
          )
        })}
        {indicator.height < trackHeight && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 rounded-sm border border-[var(--color-text-muted)]/35 bg-[var(--color-text-primary)]/[0.025]"
            style={{ top: `${indicator.top}px`, height: `${indicator.height}px` }}
          />
        )}
      </div>
    </aside>
  )
}
