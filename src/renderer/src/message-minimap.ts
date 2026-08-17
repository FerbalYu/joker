import type { ChatMessage } from '@shared/types'
import { visibleToolCards, visibleChatTools } from './tool-visibility'

export interface MinimapEntry {
  id: string
  userPreview: string
  replyPreview: string
  /** Wall-clock ms the assistant reply took; 0 when unknown. */
  durationMs: number
  /** Number of visible tool calls in the reply. */
  toolCount: number
  top: number
  height: number
}

export interface ViewportIndicator {
  top: number
  height: number
}

const LINE_HEIGHT = 2
const LINE_GAP = 8
const MIN_ENTRY_HEIGHT = 2
const PREVIEW_LENGTH = 20
/** Cap one entry at 40% of the track so a slow turn cannot consume the timeline. */
const MAX_ENTRY_HEIGHT_RATIO = 0.4

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
        replyPreview: '',
        durationMs: 0,
        toolCount: 0
      }
      entries.push(current)
      continue
    }

    if (current) {
      if (!current.replyPreview && message.content.trim()) {
        current.replyPreview = normalizePreview(message.content)
      }
      if (message.durationMs !== undefined) current.durationMs += message.durationMs
      const tools = [
        ...(message.toolCalls ?? []),
        ...(message.segments ?? []).flatMap((segment) => (segment.type === 'tools' ? segment.tools : []))
      ]
      current.toolCount += visibleChatTools(visibleToolCards(tools)).length
    }
  }

  if (streaming && current && streamText.trim()) {
    current.replyPreview = normalizePreview(streamText)
  }

  if (entries.length === 0 || trackHeight <= 0) return []

  return layoutTimeline(entries, trackHeight)
}

/**
 * Lay out entries proportionally to recorded durations (DSH-style recorded-duration
 * timeline). Turns without a recorded duration fall back to equal height.
 */
function layoutTimeline(
  entries: ReadonlyArray<Omit<MinimapEntry, 'top' | 'height'>>,
  trackHeight: number
): MinimapEntry[] {
  const hasAnyDuration = entries.some((entry) => entry.durationMs > 0)
  if (!hasAnyDuration) {
    const naturalHeight = entries.length * LINE_HEIGHT + Math.max(0, entries.length - 1) * LINE_GAP
    const scale = Math.min(1, trackHeight / naturalHeight)
    return entries.map((entry, index) => ({
      ...entry,
      top: index * (LINE_HEIGHT + LINE_GAP) * scale,
      height: Math.max(1, LINE_HEIGHT * scale)
    }))
  }

  const weights = entries.map((entry) => (entry.durationMs > 0 ? Math.max(entry.durationMs, 1) : DEFAULT_TURN_MS))
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
  const gapTotal = Math.max(0, entries.length - 1) * LINE_GAP
  const available = Math.max(entries.length * MIN_ENTRY_HEIGHT + gapTotal, trackHeight - gapTotal)
  const maxHeight = available * MAX_ENTRY_HEIGHT_RATIO
  let top = 0
  return entries.map((entry, index) => {
    const rawHeight = (weights[index] / totalWeight) * available
    const height = Math.max(MIN_ENTRY_HEIGHT, Math.min(maxHeight, rawHeight))
    const positioned = { ...entry, top, height }
    top += height + LINE_GAP
    return positioned
  })
}

const DEFAULT_TURN_MS = 3_000

export function formatEntryDuration(durationMs: number): string {
  if (durationMs <= 0) return '—'
  const seconds = durationMs / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.round(seconds % 60)
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`
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
