import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import LinkPreview from './components/LinkPreview'
import FileLink from './components/FileLink'
import { classifyLink } from './url-preview'
import './markdown.css'

const components: Components = {
  h1: ({ children }) => <h1>{children}</h1>,
  h2: ({ children }) => <h2>{children}</h2>,
  h3: ({ children }) => <h3>{children}</h3>,
  p: ({ children }) => <p>{children}</p>,
  ul: ({ children }) => <ul>{children}</ul>,
  ol: ({ children }) => <ol>{children}</ol>,
  blockquote: ({ children }) => <blockquote>{children}</blockquote>,
  a: ({ href, children }) => {
    const classification = href ? classifyLink(href) : { kind: 'other' as const, isMarkdown: false }
    if (classification.kind === 'web' && href) return <LinkPreview url={href} />
    if (classification.kind === 'file' && href) return <FileLink url={href} />
    return <span>{children}</span>
  },
  pre: ({ children }) => <pre>{children}</pre>,
  code: ({ children }) => <code>{children}</code>,
  table: ({ children }) => <div className="table-wrap"><table>{children}</table></div>,
  th: ({ children }) => <th>{children}</th>,
  td: ({ children }) => <td>{children}</td>
}

interface Payload {
  title: string
  path: string
  content: string
}

function readPayload(): Payload | null {
  return window.jokerMarkdown.getInitial()
}

export default function MarkdownWindow(): React.JSX.Element {
  const [payload, setPayload] = useState<Payload | null>(() => readPayload())
  useEffect(() => {
    const update = (): void => setPayload(readPayload())
    window.addEventListener('joker-markdown-ready', update)
    return () => window.removeEventListener('joker-markdown-ready', update)
  }, [])

  if (!payload) return <main className="empty">正在加载 Markdown…</main>
  return (
    <main className="markdown-window">
      <header>
        <strong>{payload.title}</strong>
        <span title={payload.path}>{payload.path}</span>
      </header>
      <article><ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{payload.content}</ReactMarkdown></article>
    </main>
  )
}
