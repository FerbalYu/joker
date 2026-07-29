import { useEffect, useState } from 'react'
import { Check, Copy, ExternalLink, Globe } from 'lucide-react'
import { compactUrl } from '../url-preview'
import { useStore } from '../store'
import { t } from '../i18n'
type Preview = Awaited<ReturnType<typeof window.joker.web.preview>>

const previewCache = new Map<string, Promise<Preview>>()

function loadPreview(url: string): Promise<Preview> {
  const cached = previewCache.get(url)
  if (cached) return cached
  const request = window.joker.web.preview(url)
  previewCache.set(url, request)
  return request
}

export default function LinkPreview({ url, onCopy }: { url: string; onCopy?: (url: string) => void }): React.JSX.Element {
  const language = useStore((s) => s.language)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let active = true
    void loadPreview(url).then((result) => {
      if (active) setPreview(result)
    })
    return () => {
      active = false
    }
  }, [url])

  const handleCopy = (event: React.MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    onCopy?.(url)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  const hostname = preview?.hostname ?? (() => {
    try {
      return new URL(url).hostname
    } catch {
      return ''
    }
  })()

  const display = preview?.title?.trim() || compactUrl(url)
  const copyLabel = copied ? t(language, 'input.linkCopied') : t(language, 'input.copyLink')

  return (
    <span className="my-1 inline-flex min-w-0 max-w-full items-center gap-1 align-middle">
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        title={url}
        className="inline-flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-active)]/60 px-2.5 py-1.5 text-[var(--color-text-primary)] no-underline transition-colors hover:border-[var(--color-accent)]/60 hover:bg-[var(--color-surface-active)]"
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--color-bg)] text-[var(--color-accent)]">
          <Globe size={14} />
        </span>
        <span className="min-w-0 max-w-full">
          <span className="block max-w-[min(68vw,34rem)] truncate text-xs font-medium">
            {display}
          </span>
          <span className="block max-w-[min(68vw,34rem)] truncate text-[10px] text-[var(--color-text-muted)]">
            {hostname || (language === 'zh' ? '网页链接' : 'Web link')}
          </span>
        </span>
        <ExternalLink size={13} className="shrink-0 text-[var(--color-text-muted)]" />
      </a>
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
    </span>
  )
}
