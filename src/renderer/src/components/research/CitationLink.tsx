import { useEffect, useState } from 'react'
import type { ResearchCitation, ResearchSource } from '@shared/research'
import { useStore } from '../../store'
import { t } from '../../i18n'

export default function CitationLink({ citation, source }: { citation: ResearchCitation; source: ResearchSource | undefined }): React.JSX.Element {
  const language = useStore((state) => state.language)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (!expanded) return
    document.getElementById(`research-source-${citation.sourceId}`)?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, [citation.sourceId, expanded])

  const focusSource = (): void => {
    setExpanded((value) => !value)
  }

  return (
    <span className="relative inline-flex align-baseline">
      <button type="button" onClick={focusSource} aria-expanded={expanded} aria-label={t(language, 'research.citation.label', { id: citation.sourceId })} className="mx-0.5 inline-flex min-h-6 items-center rounded bg-[var(--color-accent)]/10 px-1.5 font-mono text-[10px] font-semibold text-[var(--color-accent)] hover:bg-[var(--color-accent)]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]">[{citation.sourceId}]</button>
      {expanded && <span className="absolute left-0 top-full z-20 mt-1 w-72 max-w-[70vw] rounded-lg border border-[var(--color-border-light)] bg-[var(--color-surface)] p-3 text-left text-xs font-normal leading-5 text-[var(--color-text-secondary)] shadow-2xl"><span className="block text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">{source?.title ?? source?.hostname ?? citation.sourceId}</span><span className="mt-1 block">“{citation.quote}”</span></span>}
    </span>
  )
}
