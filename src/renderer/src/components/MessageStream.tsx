import { useEffect, useRef, useState } from 'react'
import { Copy, Loader2, Pencil, Send, X } from 'lucide-react'
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
import { segmentsFromLegacyMessage } from '../assistant-segments'
import { splitUrls, classifyLink } from '../url-preview'
import { extractResearchReports, visibleChatTools } from '../tool-visibility'
import ResearchReportView from './research/ResearchReportView'
import logoUrl from '../../../image/logo.png'

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
    if (classification.kind === 'file' && href) return <FileLink url={href} onCopy={onCopyLink} />
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
  pendingToolCalls: ToolCallInfo[]
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
  pendingToolCalls,
  onCopyLink,
  onCopyMessage,
  onEditMessage
}: Props): React.JSX.Element {
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const nearBottomRef = useRef(true)
  const language = useStore((s) => s.language)

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

  useEffect(() => {
    if (nearBottomRef.current) bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [messages, streamText, streamSegments, pendingToolCalls])

  return (
    <div ref={scrollRef} className="relative flex min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
      <MessageMinimap
        messages={messages}
        streamText={streamText}
        streaming={streaming}
        pendingToolCalls={pendingToolCalls}
        scrollRef={scrollRef}
      />
      <div className="mx-auto min-w-0 flex-1 px-[35px] pt-6">
        {messages.length === 0 && !streaming && (
          <div className="flex h-full min-h-[40vh] flex-col items-center justify-center text-center">
            <p className="text-sm text-[var(--color-text-muted)]">{t(language, 'message.welcome')}</p>
          </div>
        )}

        {messages.map((message) => (
          <MessageRow
            key={message.id}
            message={message}
            language={language}
            streaming={streaming}
            onCopyLink={onCopyLink}
            onCopyMessage={onCopyMessage}
            onEditMessage={onEditMessage}
          />
        ))}

        {streaming && (
          <StreamingReply
            streamSegments={streamSegments}
            runMode={streamRunMode}
            language={language}
            onCopyLink={onCopyLink}
          />
        )}

        <div className="h-[35px] shrink-0" ref={bottomRef} />
      </div>
    </div>
  )
}

function StreamingReply({
  streamSegments,
  runMode,
  language,
  onCopyLink
}: {
  streamSegments: AssistantSegment[]
  runMode: RunMode | null
  language: Language
  onCopyLink?: (url: string) => void
}): React.JSX.Element | null {
  if (streamSegments.length === 0) {
    return (
      <div className="mb-6 flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
        <Loader2 size={14} className="animate-spin text-[var(--color-accent)]" />
        {t(language, 'message.thinking')}
      </div>
    )
  }

  return (
    <div className="mb-6 min-w-0">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-[var(--color-accent)]"><img src={logoUrl} alt="" className="h-4 w-4 rounded object-cover" />JOKER</div>
      <AssistantSegmentsView segments={streamSegments} streaming runMode={runMode} onCopyLink={onCopyLink} />
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
              <MarkdownContent content={segment.text} onCopyLink={onCopyLink} />
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

function MarkdownContent({ content, onCopyLink }: { content: string; onCopyLink?: (url: string) => void }): React.JSX.Element {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents(onCopyLink)}>
      {content}
    </ReactMarkdown>
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
            ? <FileLink key={`${token.value}-${index}`} url={token.value} onCopy={onCopyLink} />
            : <LinkPreview key={`${token.value}-${index}`} url={token.value} onCopy={onCopyLink} />
        }
        return <span key={`${token.value}-${index}`}>{token.value}</span>
      })}
    </div>
  )
}
function MessageRow({ message, language, streaming, onCopyLink, onCopyMessage, onEditMessage }: { message: ChatMessage; language: Language; streaming: boolean; onCopyLink?: (url: string) => void; onCopyMessage?: (text: string) => void; onEditMessage?: (messageId: string, text: string) => Promise<boolean> }): React.JSX.Element {
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
    <div className={`group mb-6 flex ${isUser ? 'justify-end' : 'justify-start'}`}>
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
        <div className={`mt-1 flex w-full items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 ${isUser ? 'justify-end' : 'justify-start'}`}>
          {onCopyMessage && <button type="button" onClick={() => onCopyMessage(message.content)} aria-label={t(language, 'message.copy')} title={t(language, 'message.copy')} className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-active)] hover:text-[var(--color-accent)]"><Copy size={13} /></button>}
          {canEdit && <button type="button" onClick={() => { setEditText(message.content); setEditError(null); setEditing(true) }} aria-label={t(language, 'message.edit')} title={t(language, 'message.edit')} className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-active)] hover:text-[var(--color-accent)]"><Pencil size={13} /></button>}
        </div>
      </div>
    </div>
  )
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}
