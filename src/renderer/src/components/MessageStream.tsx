import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Copy, FolderOpen, Loader2, Pencil, Send, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import type { AssistantSegment, ChatMessage, RunMode, ToolCallInfo } from '@shared/types'
import { useStore } from '../store'
import { t, type Language } from '../i18n'
import ImagePreview from './ImagePreview'
import LinkPreview from './LinkPreview'
import FileLink from './FileLink'
import ToolCallList from './ToolCallList'
import MessageMinimap from './MessageMinimap'
import ProducedFiles from './ProducedFiles'
import { mergeAdjacentSegments, segmentsFromLegacyMessage } from '../assistant-segments'
import { splitUrls, classifyLink } from '../url-preview'
import { extractResearchReports, visibleChatTools } from '../tool-visibility'
import ResearchReportView from './research/ResearchReportView'
import type { RunActivityState } from '../run-activity'
import { toRunActivityViewModel } from '../run-activity'
import { partitionStreamingMarkdown } from '../streaming-markdown'
import { markdownUrlTransform } from '../markdown-links'
import logoUrl from '../../../image/logo.png'

const INITIAL_VISIBLE_MESSAGES = 60
const MESSAGE_PAGE_SIZE = 40

const markdownComponents = (onCopyLink?: (url: string) => void): Components => ({
  h1: ({ children }) => <h1 className="mb-3 mt-5 text-xl font-semibold text-[var(--color-text-primary)] first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2 mt-4 text-lg font-semibold text-[var(--color-text-primary)] first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-2 mt-3 text-base font-semibold text-[var(--color-text-primary)] first:mt-0">{children}</h3>,
  p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="pl-1">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="mb-3 border-l-2 border-[var(--color-accent)]/60 pl-3 text-[var(--color-text-secondary)]">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => {
    const classification = href ? classifyLink(href) : { kind: 'other' as const, isMarkdown: false }
    if (classification.kind === 'web' && href) return <LinkPreview url={href} onCopy={onCopyLink} />
    if (classification.kind === 'file' && href) return <FileLink url={href} />
    return <span className="break-words">{children}</span>
  },
  code: ({ className, children, ...props }) => {
    const isBlock = Boolean(className)
    if (!isBlock) {
      return (
        <code className="rounded bg-[var(--color-surface-active)] px-1.5 py-0.5 font-mono text-[0.9em] text-[var(--color-accent-light)]" {...props}>
          {children}
        </code>
      )
    }
    return (
      <code className="block max-w-full overflow-hidden whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5 text-[var(--color-text-primary)]" {...props}>
        {children}
      </code>
    )
  },
  pre: ({ children }) => <pre className="mb-3 max-w-full overflow-hidden whitespace-pre-wrap break-words rounded-lg border border-[var(--color-border)] bg-[#08090a] last:mb-0">{children}</pre>,
  hr: () => <hr className="my-4 border-[var(--color-border)]" />,
  table: ({ children }) => <div className="mb-3 max-w-full overflow-x-auto"><table className="min-w-full border-collapse text-left text-xs">{children}</table></div>,
  th: ({ children }) => <th className="border border-[var(--color-border)] bg-[var(--color-surface-active)] px-3 py-2 font-medium">{children}</th>,
  td: ({ children }) => <td className="border border-[var(--color-border)] px-3 py-2">{children}</td>
})

interface Props {
  messages: ChatMessage[]
  streamText: string
  streamSegments: AssistantSegment[]
  streaming: boolean
  streamRunMode: RunMode | null
  runActivity: RunActivityState
  onCopyLink?: (url: string) => void
  onCopyMessage?: (text: string) => void
  onEditMessage?: (messageId: string, text: string) => Promise<boolean>
}

export default function MessageStream({
  messages,
  streamText,
  streamSegments,
  streaming,
  streamRunMode,
  runActivity,
  onCopyLink,
  onCopyMessage,
  onEditMessage
}: Props): React.JSX.Element {
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const nearBottomRef = useRef(true)
  const scrollFrameRef = useRef<number | null>(null)
  const prependSnapshotRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null)
  const language = useStore((s) => s.language)
  const mergedMessages = useMemo(() => mergeAssistantStepMessages(messages), [messages])
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_MESSAGES)
  const visibleMessages = useMemo(
    () => mergedMessages.slice(Math.max(0, mergedMessages.length - visibleCount)),
    [mergedMessages, visibleCount]
  )
  const hiddenMessageCount = Math.max(0, mergedMessages.length - visibleMessages.length)

  useEffect(() => {
    const scrollElement = scrollRef.current
    if (!scrollElement) return

    const updateNearBottom = (): void => {
      nearBottomRef.current =
        scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight < 96
    }

    updateNearBottom()
    scrollElement.addEventListener('scroll', updateNearBottom, { passive: true })
    return () => scrollElement.removeEventListener('scroll', updateNearBottom)
  }, [])

  useLayoutEffect(() => {
    const snapshot = prependSnapshotRef.current
    const scrollElement = scrollRef.current
    if (!snapshot || !scrollElement) return
    scrollElement.scrollTop = snapshot.scrollTop + (scrollElement.scrollHeight - snapshot.scrollHeight)
    prependSnapshotRef.current = null
  }, [visibleMessages.length])

  useEffect(() => {
    if (!nearBottomRef.current) return
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current)
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      const scrollElement = scrollRef.current
      if (scrollElement && nearBottomRef.current) scrollElement.scrollTop = scrollElement.scrollHeight
      scrollFrameRef.current = null
    })
    return () => {
      if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current)
      scrollFrameRef.current = null
    }
  }, [messages, streamSegments])

  const loadEarlierMessages = (): void => {
    const scrollElement = scrollRef.current
    if (scrollElement) {
      prependSnapshotRef.current = { scrollHeight: scrollElement.scrollHeight, scrollTop: scrollElement.scrollTop }
      nearBottomRef.current = false
    }
    setVisibleCount((count) => Math.min(mergedMessages.length, count + MESSAGE_PAGE_SIZE))
  }

  return (
    <div ref={scrollRef} data-message-stream-scroll className="relative flex min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
      <MessageMinimap
        messages={visibleMessages}
        streamText={streamText}
        streaming={streaming}
        scrollRef={scrollRef}
      />
      <div data-message-stream-content className="mx-auto min-w-0 w-full max-w-3xl flex-1 px-6 pt-6">
        {messages.length === 0 && !streaming && (
          <WelcomeState />
        )}

        {hiddenMessageCount > 0 && (
          <div className="mb-6 flex justify-center">
            <button
              data-history-window
              type="button"
              onClick={loadEarlierMessages}
              className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-light)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
            >
              {t(language, 'message.loadEarlier', { shown: visibleMessages.length, total: mergedMessages.length })}
            </button>
          </div>
        )}

        {visibleMessages.map((message, index) => (
          <MessageRow
            key={message.id}
            message={message}
            language={language}
            streaming={streaming}
            turnToolCalls={turnToolCallsAt(visibleMessages, index)}
            onCopyLink={onCopyLink}
            onCopyMessage={onCopyMessage}
            onEditMessage={onEditMessage}
          />
        ))}

        {streaming && (
          <StreamingReply
            streamSegments={streamSegments}
            runMode={streamRunMode}
            activity={runActivity}
            language={language}
            onCopyLink={onCopyLink}
          />
        )}

        <div className="h-[35px] shrink-0" ref={bottomRef} />
      </div>
    </div>
  )
}

function WelcomeState(): React.JSX.Element {
  const language = useStore((s) => s.language)
  const config = useStore((s) => s.config)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const providerName = config?.providers.find((provider) => provider.id === config.activeProviderId)?.name
    ?? config?.providers.find((provider) => provider.enabled)?.name
  const samples = ['welcome.sample.explain', 'welcome.sample.fix', 'welcome.sample.build'] as const
  return (
    <div data-welcome-state className="flex h-full min-h-[55vh] flex-col items-center justify-center gap-5 text-center">
      <img src={logoUrl} alt="" className="h-10 w-10 rounded-lg" />
      <div>
        <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">{t(language, 'message.welcome')}</h1>
        {providerName && <p className="mt-1 text-xs text-[var(--color-text-muted)]">{providerName}</p>}
      </div>
      {!activeProjectId && (
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent('joker:welcome-pick-folder'))}
          className="flex items-center gap-2 rounded-md border border-[var(--color-accent)]/60 bg-[var(--color-accent)]/10 px-4 py-2 text-sm text-[var(--color-accent)] transition hover:bg-[var(--color-accent)]/20"
        >
          <FolderOpen size={15} />
          {t(language, 'welcome.pickFolder')}
        </button>
      )}
      <div className="flex max-w-lg flex-wrap items-center justify-center gap-2">
        {samples.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent('joker:welcome-insert', { detail: { text: t(language, key) } }))}
            className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] transition hover:border-[var(--color-border-light)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
          >
            {t(language, key)}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-[var(--color-text-muted)]">{t(language, 'welcome.commandsHint')}</p>
    </div>
  )
}

function StreamingReply({
  streamSegments,
  runMode,
  activity,
  language,
  onCopyLink
}: {
  streamSegments: AssistantSegment[]
  runMode: RunMode | null
  activity: RunActivityState
  language: Language
  onCopyLink?: (url: string) => void
}): React.JSX.Element | null {
  const activityView = toRunActivityViewModel(activity, language)
  if (streamSegments.length === 0) {
    return (
      <div className="mb-6 min-w-0">
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-[var(--color-accent)]"><img src={logoUrl} alt="" className="h-4 w-4 rounded object-cover" />JOKER</div>
        <RunStatusIndicator view={activityView} />
      </div>
    )
  }

  return (
    <div data-streaming-reply className="mb-6 min-w-0">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-[var(--color-accent)]"><img src={logoUrl} alt="" className="h-4 w-4 rounded object-cover" />JOKER</div>
      <AssistantSegmentsView segments={streamSegments} streaming runMode={runMode} onCopyLink={onCopyLink} />
      <div className="mt-3"><RunStatusIndicator view={activityView} /></div>
    </div>
  )
}

function RunStatusIndicator({ view }: { view: ReturnType<typeof toRunActivityViewModel> }): React.JSX.Element {
  const spinning = view.phase !== 'awaiting-approval' && view.phase !== 'failed' && view.phase !== 'cancelled'
  return (
    <div role="status" aria-live="polite" data-run-status={view.phase} data-status={view.dataStatus} className="flex min-h-6 items-center gap-2 text-xs text-[var(--color-text-muted)]">
      {spinning ? <Loader2 size={13} className="animate-spin text-[var(--color-accent)] motion-reduce:animate-none" /> : <span className="h-2 w-2 rounded-full bg-[var(--color-accent)]" />}
      <span>{view.label}</span>
      {view.toolName && <span className="truncate text-[var(--color-text-secondary)]">· {view.toolName}{view.toolCount && view.toolCount > 1 ? ` +${view.toolCount - 1}` : ''}</span>}
    </div>
  )
}

function AssistantSegmentsView({
  segments,
  streaming = false,
  runMode = null,
  onCopyLink
}: {
  segments: AssistantSegment[]
  streaming?: boolean
  runMode?: RunMode | null
  onCopyLink?: (url: string) => void
}): React.JSX.Element {
  return (
    <div className="space-y-4">
      {segments.map((segment, index) => {
        if (segment.type === 'text') {
          if (!segment.text) return null
          const isLiveTail = streaming && index === segments.length - 1
          return (
            <div key={`text-${index}`} className="text-sm leading-6 text-[var(--color-text-primary)]">
              {isLiveTail
                ? <StreamingMarkdownContent content={segment.text} onCopyLink={onCopyLink} />
                : <MarkdownContent content={segment.text} onCopyLink={onCopyLink} />}
              {isLiveTail && (
                <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-[var(--color-accent)] align-middle" />
              )}
            </div>
          )
        }
        const visibleTools = visibleChatTools(segment.tools)
        const reports = extractResearchReports(segment.tools)
        if (visibleTools.length === 0 && reports.length === 0) return null
        return (
          <div key={`tools-${index}`} className="w-full space-y-4">
            {visibleTools.length > 0 && <ToolCallList toolCalls={visibleTools} />}
            {reports.map((artifact, reportIndex) => (
              <ResearchReportView key={artifact.toolCall.toolCallId ?? `report-${reportIndex}`} metadata={artifact.toolCall.metadata} status={artifact.toolCall.status} runMode={runMode} />
            ))}
          </div>
        )
      })}
    </div>
  )
}

function mergeAssistantStepMessages(messages: ChatMessage[]): ChatMessage[] {
  const merged: ChatMessage[] = []
  for (const message of messages) {
    const previous = merged.at(-1)
    if (message.role === 'assistant' && previous?.role === 'assistant' && isStepMessage(previous) && isStepMessage(message)) {
      const previousSegments = previous.segments ?? segmentsFromLegacyMessage(previous.content, previous.toolCalls)
      const nextSegments = message.segments ?? segmentsFromLegacyMessage(message.content, message.toolCalls)
      const segments = mergeAdjacentSegments([...previousSegments, ...nextSegments])
      merged[merged.length - 1] = {
        ...previous,
        id: `${previous.id}+${message.id}`,
        content: previous.content + message.content,
        toolCalls: segments.flatMap((segment) => segment.type === 'tools' ? segment.tools : []),
        segments,
        usage: message.usage ?? previous.usage,
        durationMs: message.durationMs ?? previous.durationMs,
        createdAt: message.createdAt
      }
      continue
    }
    merged.push(message)
  }
  return merged
}

function isStepMessage(message: ChatMessage): boolean {
  return /-step-\d+$/.test(message.id)
}

/**
 * Tool calls of the assistant turn a message belongs to: every assistant
 * message from the last user boundary up to and including this one.
 */
function turnToolCallsAt(messages: ChatMessage[], index: number): ToolCallInfo[] {
  let start = index
  while (start > 0 && messages[start - 1].role === 'assistant') start -= 1
  const toolCalls: ToolCallInfo[] = []
  for (const message of messages.slice(start, index + 1)) {
    if (message.role !== 'assistant') continue
    const fromSegments = (message.segments ?? []).flatMap((segment) => (segment.type === 'tools' ? segment.tools : []))
    for (const toolCall of message.toolCalls ?? fromSegments) toolCalls.push(toolCall)
  }
  return toolCalls
}

const MarkdownContent = memo(function MarkdownContent({ content, onCopyLink }: { content: string; onCopyLink?: (url: string) => void }): React.JSX.Element {
  const components = useMemo(() => markdownComponents(onCopyLink), [onCopyLink])
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={markdownUrlTransform}>
      {content}
    </ReactMarkdown>
  )
})

function StreamingMarkdownContent({ content, onCopyLink }: { content: string; onCopyLink?: (url: string) => void }): React.JSX.Element {
  const partition = useMemo(() => partitionStreamingMarkdown(content), [content])
  return (
    <>
      {partition.blocks.map((block, index) => <MarkdownContent key={`${index}-${block.length}`} content={block} onCopyLink={onCopyLink} />)}
      {partition.tail && <span className="whitespace-pre-wrap break-words">{partition.tail}</span>}
    </>
  )
}

function MessageParts({ message, language, onCopyLink }: { message: ChatMessage; language: Language; onCopyLink?: (url: string) => void }): React.JSX.Element {
  if (!message.parts) return <UrlAwareText text={message.content} onCopyLink={onCopyLink} />
  const images = message.parts.filter((part) => part.type === 'image')
  const textParts = message.parts.filter((part) => part.type === 'text')
  return (
    <div className="space-y-2">
      {images.length > 0 && (
        <div data-message-attachments className="flex flex-wrap justify-end gap-2">
          {images.map((image, index) => <ImagePreview key={index} image={image} language={language} mode="attachment" />)}
        </div>
      )}
      {textParts.map((part, index) => <UrlAwareText key={index} text={part.text} onCopyLink={onCopyLink} />)}
    </div>
  )
}

function UrlAwareText({ text, onCopyLink }: { text: string; onCopyLink?: (url: string) => void }): React.JSX.Element {
  return (
    <div className="whitespace-pre-wrap break-words">
      {splitUrls(text).map((token, index) => {
        if (token.type === 'url') {
          const classification = classifyLink(token.value)
          return classification.kind === 'file'
            ? <FileLink key={`${token.value}-${index}`} url={token.value} />
            : <LinkPreview key={`${token.value}-${index}`} url={token.value} onCopy={onCopyLink} />
        }
        return <span key={`${token.value}-${index}`}>{token.value}</span>
      })}
    </div>
  )
}
const MessageRow = memo(function MessageRow({ message, language, streaming, turnToolCalls = [], onCopyLink, onCopyMessage, onEditMessage }: { message: ChatMessage; language: Language; streaming: boolean; turnToolCalls?: ToolCallInfo[]; onCopyLink?: (url: string) => void; onCopyMessage?: (text: string) => void; onEditMessage?: (messageId: string, text: string) => Promise<boolean> }): React.JSX.Element {
  const isUser = message.role === 'user'
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState(message.content)
  const [editError, setEditError] = useState<string | null>(null)
  const editRef = useRef<HTMLTextAreaElement>(null)
  const canEdit = isUser && !streaming && !message.parts?.some((part) => part.type === 'image') && Boolean(onEditMessage)

  useEffect(() => {
    if (editing) {
      editRef.current?.focus()
      editRef.current?.setSelectionRange(editText.length, editText.length)
    }
  }, [editing, editText.length])

  const submitEdit = async (): Promise<void> => {
    const value = editText.trim()
    if (!value || !onEditMessage) return
    setEditError(null)
    const saved = await onEditMessage(message.id, value)
    if (saved) setEditing(false)
    else setEditError(t(language, 'message.editFailed'))
  }

const assistantSegments = !isUser
    ? (message.segments && message.segments.length > 0
      ? message.segments
      : segmentsFromLegacyMessage(message.content, message.toolCalls))
    : []
  const content = isUser
    ? <MessageParts message={message} language={language} onCopyLink={onCopyLink} />
    : <AssistantSegmentsView segments={assistantSegments} runMode={message.runMode ?? null} onCopyLink={onCopyLink} />
  const duration = !isUser && message.durationMs !== undefined ? formatDuration(message.durationMs) : null

  return (
    <div data-message-row data-message-role={message.role} className={`group mb-6 flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`min-w-0 max-w-[calc(100%-70px)] ${isUser ? 'ml-auto items-end' : 'mr-auto items-start'} flex flex-col`}>
        <div className={`mb-1 flex w-full items-center gap-2 text-xs font-medium ${isUser ? 'justify-end text-[var(--color-text-secondary)]' : 'text-[var(--color-accent)]'} `}>
          <span>{isUser ? t(language, 'message.you') : 'JOKER'}</span>
        </div>
        {editing ? (
          <div className="w-full rounded-xl border border-[var(--color-accent)]/60 bg-[var(--color-surface-active)] p-2">
            <textarea ref={editRef} value={editText} onChange={(event) => setEditText(event.target.value)} rows={3} className="w-full resize-none bg-transparent text-sm leading-6 text-[var(--color-text-primary)] focus:outline-none" />
            {editError && <p className="px-1 pb-1 text-xs text-red-400">{editError}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setEditing(false)} className="rounded-md px-2.5 py-1 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-bg)]"><X size={13} className="mr-1 inline" />{t(language, 'message.cancelEdit')}</button>
              <button type="button" onClick={() => void submitEdit()} disabled={!editText.trim()} className="rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-xs text-[var(--color-bg)] disabled:opacity-40"><Send size={13} className="mr-1 inline" />{t(language, 'message.editSend')}</button>
            </div>
          </div>
        ) : (
          <div className="w-full text-sm leading-6 text-[var(--color-text-primary)]">{content}</div>
        )}
        {duration && <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">{language === 'zh' ? `已处理 ${duration}` : `Processed ${duration}`}</div>}
        {!isUser && <ProducedFiles toolCalls={turnToolCalls} />}
        <div className={`mt-1 flex w-full items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 ${isUser ? 'justify-end' : 'justify-start'}`}>
          {onCopyMessage && <button type="button" onClick={() => onCopyMessage(message.content)} aria-label={t(language, 'message.copy')} title={t(language, 'message.copy')} className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-active)] hover:text-[var(--color-accent)]"><Copy size={13} /></button>}
          {canEdit && <button type="button" onClick={() => { setEditText(message.content); setEditError(null); setEditing(true) }} aria-label={t(language, 'message.edit')} title={t(language, 'message.edit')} className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-active)] hover:text-[var(--color-accent)]"><Pencil size={13} /></button>}
        </div>
      </div>
    </div>
  )
})

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}
