import type { ChatMessage } from '@shared/types'

export interface MinimapEntry {
  id: string
  userPreview: string
  replyPreview: string
  top: number
  height: number
}

export interface ViewportIndicator {
  top: number
  height: number
}

const LINE_HEIGHT = 2
const LINE_GAP = 8
const PREVIEW_LENGTH = 20

export function buildMinimapEntries(
  messages: readonly ChatMessage[],
  streamText: string,
  streaming: boolean,
  trackHeight: number
): MinimapEntry[] {
  const entries: Array<Omit<MinimapEntry, 'top' | 'height'>> = []
  let current: Omit<MinimapEntry, 'top' | 'height'> | null = null

  for (const message of messages) {
    if (message.role === 'user') {
      current = {
        id: message.id,
        userPreview: normalizePreview(message.content || imageFallback(message)),
        replyPreview: ''
      }
      entries.push(current)
      continue
    }

    if (current && !current.replyPreview && message.content.trim()) {
      current.replyPreview = normalizePreview(message.content)
    }
  }

  if (streaming && current && streamText.trim()) {
    current.replyPreview = normalizePreview(streamText)
  }

  if (entries.length === 0 || trackHeight <= 0) return []

  const naturalHeight = entries.length * LINE_HEIGHT + Math.max(0, entries.length - 1) * LINE_GAP
  const scale = Math.min(1, trackHeight / naturalHeight)
  return entries.map((entry, index) => ({
    ...entry,
    top: index * (LINE_HEIGHT + LINE_GAP) * scale,
    height: Math.max(1, LINE_HEIGHT * scale)
  }))
}

export function truncatePreview(value: string): string {
  const normalized = normalizePreview(value)
  return normalized.length > PREVIEW_LENGTH
    ? `${normalized.slice(0, PREVIEW_LENGTH)}....`
    : normalized
}

function normalizePreview(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function calculateViewportIndicator(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  trackHeight: number,
  minimumHeight = 24
): ViewportIndicator {
  if (trackHeight <= 0) return { top: 0, height: 0 }
  if (scrollHeight <= clientHeight || scrollHeight <= 0 || clientHeight <= 0) {
    return { top: 0, height: trackHeight }
  }

  const height = Math.min(trackHeight, Math.max(minimumHeight, trackHeight * (clientHeight / scrollHeight)))
  const maxScrollTop = Math.max(1, scrollHeight - clientHeight)
  const top = (trackHeight - height) * clamp(scrollTop / maxScrollTop, 0, 1)
  return { top, height }
}

export function minimapClickToScrollTop(
  pointerY: number,
  trackHeight: number,
  indicatorHeight: number,
  scrollHeight: number,
  clientHeight: number
): number {
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight)
  const travel = Math.max(1, trackHeight - indicatorHeight)
  const ratio = clamp((pointerY - indicatorHeight / 2) / travel, 0, 1)
  return ratio * maxScrollTop
}

function imageFallback(message: ChatMessage): string {
  return message.parts?.some((part) => part.type === 'image') ? '图片消息' : ''
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
