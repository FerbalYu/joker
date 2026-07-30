import type { ResearchSource } from '@shared/research'
import { ExternalLink } from 'lucide-react'
import { useStore } from '../../store'
import { t } from '../../i18n'

export default function SourceList({ sources }: { sources: ResearchSource[] }): React.JSX.Element {
  const language = useStore((state) => state.language)
  return (
    <section aria-labelledby="research-sources-heading" className="mt-8 border-t border-[var(--color-border)] pt-5">
      <h3 id="research-sources-heading" className="text-base font-semibold text-[var(--color-text-primary)]">{t(language, 'research.sources')}</h3>
      <ol className="mt-3 space-y-2">
        {sources.map((source) => (
          <li id={`research-source-${source.sourceId}`} key={source.sourceId} className="scroll-mt-24 rounded-lg bg-[var(--color-bg)] px-3 py-2 text-xs text-[var(--color-text-secondary)] focus-within:ring-2 focus-within:ring-[var(--color-accent)]">
            <div className="flex items-start gap-2">
              <span className="shrink-0 font-mono font-semibold text-[var(--color-accent)]">[{source.sourceId}]</span>
              <div className="min-w-0 flex-1">
                <a href={source.url} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 font-medium text-[var(--color-text-primary)] hover:text-[var(--color-accent)]">
                  <span className="truncate">{source.title ?? source.hostname}</span><ExternalLink size={12} className="shrink-0" />
                </a>
                <p className="mt-0.5 truncate text-[10px] text-[var(--color-text-muted)]" title={source.url}>{source.hostname}</p>
                <time dateTime={source.retrievedAt} className="mt-0.5 block text-[10px] text-[var(--color-text-muted)]">{new Date(source.retrievedAt).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')}</time>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}
