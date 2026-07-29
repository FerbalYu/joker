import { useState } from 'react'
import { Check, Copy, FileText, FolderOpen } from 'lucide-react'
import { useStore } from '../store'
import { classifyLink } from '../url-preview'

export default function FileLink({ url, onCopy }: { url: string; onCopy?: (url: string) => void }): React.JSX.Element {
  const language = useStore((s) => s.language)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const isMarkdown = classifyLink(url).isMarkdown
  let name = url
  try {
    const parsed = new URL(url)
    name = decodeURIComponent(parsed.pathname.split('/').pop() || parsed.pathname)
  } catch {
    // Keep the raw value as a safe fallback label.
  }

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    setError(null)
    const action = isMarkdown ? window.joker.markdown.openFile(url) : window.joker.file.reveal(url)
    void action.then((result) => {
      if (!result.success) setError(result.error ?? (language === 'zh' ? '打开失败' : 'Unable to open'))
    })
  }

  const handleCopy = (event: React.MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    onCopy?.(url)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  const copyLabel = copied ? (language === 'zh' ? '已添加到输入框' : 'Added to input') : (language === 'zh' ? '复制到输入框' : 'Copy to input')

  return (
    <span className="my-1 inline-flex max-w-full min-w-0 items-center gap-1 align-middle">
      <button
        type="button"
        onClick={handleClick}
        title={url}
        className="inline-flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-active)]/60 px-2.5 py-1.5 text-left text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-accent)]/60 hover:bg-[var(--color-surface-active)]"
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--color-bg)] text-[var(--color-accent)]">
          {isMarkdown ? <FileText size={14} /> : <FolderOpen size={14} />}
        </span>
        <span className="min-w-0 max-w-[min(68vw,34rem)] truncate text-xs font-medium">
          {name}
        </span>
        <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">
          {isMarkdown ? 'JOKER Markdown' : (language === 'zh' ? '资源管理器' : 'Explorer')}
        </span>
      </button>
      {onCopy && (
        <button
          type="button"
          onClick={handleCopy}
          aria-label={copyLabel}
          title={copyLabel}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-active)] hover:text-[var(--color-accent)]"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      )}
      {error && <span className="ml-2 self-center text-[10px] text-red-400">{error}</span>}
    </span>
  )
}
