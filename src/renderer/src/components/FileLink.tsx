import { useState } from 'react'
import { FileText, FolderOpen } from 'lucide-react'
import { useStore } from '../store'
import { classifyLink } from '../url-preview'
import { localizeError } from '../i18n'

export default function FileLink({ url }: { url: string }): React.JSX.Element {
  const language = useStore((s) => s.language)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
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
    setNotice(null)
    const action = isMarkdown ? window.joker.markdown.openFile(url) : window.joker.file.reveal(url)
    void action
      .then((result) => {
        if (!result.success) setError(localizeError(language, result.error ?? (language === 'zh' ? '打开失败' : 'Unable to open')))
      })
      .catch((reason) => setError(localizeError(language, reason)))
  }

  const handleContextMenu = (event: React.MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    setError(null)
    setNotice(null)
    void window.joker.file.showContextMenu(url, language)
      .then((result) => {
        if (result.canceled) return
        if (!result.success) {
          setError(localizeError(language, result.error ?? (language === 'zh' ? '文件操作失败' : 'File action failed')))
          return
        }
        const message = contextActionNotice(language, result.action)
        if (message) {
          setNotice(message)
          window.setTimeout(() => setNotice(null), 2000)
        }
      })
      .catch((reason) => setError(localizeError(language, reason)))
  }

  return (
    <span className="mx-0.5 inline-flex max-w-full min-w-0 items-baseline gap-1.5 align-baseline">
      <button
        type="button"
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        data-testid="file-link"
        aria-label={`${language === 'zh' ? '打开文件' : 'Open file'}：${name}`}
        title={url}
        className="group inline-flex min-w-0 max-w-full items-center gap-1.5 border-0 bg-transparent p-0 text-left text-[var(--color-accent-light)] transition-colors hover:text-[var(--color-accent)] focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
      >
        {isMarkdown
          ? <FileText size={14} className="shrink-0 text-[var(--color-accent)]" />
          : <FolderOpen size={14} className="shrink-0 text-[var(--color-accent)]" />}
        <span
          data-file-link-name
          className="min-w-0 max-w-[min(68vw,34rem)] truncate border-b border-dotted border-[var(--color-accent)]/60 pb-px text-[0.95em] font-medium leading-tight group-hover:border-[var(--color-accent)]"
        >
          {name}
        </span>
      </button>
      {notice && <span role="status" className="ml-2 self-center text-[10px] text-emerald-400">{notice}</span>}
      {error && <span className="ml-2 self-center text-[10px] text-red-400">{error}</span>}
    </span>
  )
}

function contextActionNotice(
  language: 'zh' | 'en',
  action: 'open' | 'reveal' | 'open-with' | 'copy-path' | 'copy-contents' | undefined
): string | null {
  if (!action) return null
  const messages = language === 'zh'
    ? {
        open: '已请求打开文件',
        reveal: '已在资源管理器中定位',
        'open-with': '已打开“打开方式”',
        'copy-path': '已复制绝对路径',
        'copy-contents': '已复制文件内容'
      }
    : {
        open: 'File open requested',
        reveal: 'Shown in File Explorer',
        'open-with': 'Open with dialog shown',
        'copy-path': 'Absolute path copied',
        'copy-contents': 'File contents copied'
      }
  return messages[action]
}
