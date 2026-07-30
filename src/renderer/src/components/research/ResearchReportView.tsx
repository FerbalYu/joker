import { useEffect, useState } from 'react'
import { AlertTriangle, Check, Download, FileText, Loader2 } from 'lucide-react'
import type { RunMode, ToolCallInfo } from '@shared/types'
import { parseResearchReportMetadata, serializeResearchReportMarkdown } from '../../research-report'
import { useStore } from '../../store'
import { t } from '../../i18n'
import CitationLink from './CitationLink'
import ResearchChart from './ResearchChart'
import SourceList from './SourceList'

export default function ResearchReportView({ metadata, status, runMode }: { metadata: ToolCallInfo['metadata']; status: ToolCallInfo['status']; runMode: RunMode | null }): React.JSX.Element {
  const language = useStore((state) => state.language)
  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'saved' | 'error' | null>(null)

  useEffect(() => {
    if (!saveStatus) return
    const timer = window.setTimeout(() => setSaveStatus(null), 3000)
    return () => window.clearTimeout(timer)
  }, [saveStatus])
  if (status === 'running') {
    return <div role="status" aria-live="polite" className="flex max-w-[920px] items-center gap-2 rounded-xl bg-[var(--color-surface)] p-4 text-sm text-[var(--color-text-secondary)] shadow-[inset_0_0_0_1px_var(--color-border)]"><Loader2 size={16} className="animate-spin text-[var(--color-accent)] motion-reduce:animate-none" />{t(language, 'research.report.preparing')}</div>
  }
  const parsed = parseResearchReportMetadata(metadata)
  if (!parsed.success) {
    return <div role="alert" className="flex max-w-[920px] items-start gap-3 rounded-xl bg-red-950/30 p-4 text-sm text-red-200 shadow-[inset_0_0_0_1px_rgba(248,113,113,0.35)]"><AlertTriangle size={18} className="mt-0.5 shrink-0" /><div><p className="font-medium">{t(language, 'research.report.invalidTitle')}</p><p className="mt-1 text-xs text-red-200/75">{t(language, 'research.report.invalid')}</p></div></div>
  }

  const report = parsed.report
  const sources = new Map(report.sources.map((source) => [source.sourceId, source]))
  const downloadReport = async (): Promise<void> => {
    setSaving(true)
    setSaveStatus(null)
    try {
      const result = await window.joker.file.saveMarkdown({ title: report.title, content: serializeResearchReportMarkdown(report) })
      if (result.success) setSaveStatus('saved')
      else if (!result.canceled) setSaveStatus('error')
    } catch {
      setSaveStatus('error')
    } finally {
      setSaving(false)
    }
  }
  return (
    <article className="w-full max-w-[920px] rounded-2xl bg-[var(--color-surface)] p-5 shadow-[inset_0_0_0_1px_var(--color-border),0_18px_50px_rgba(0,0,0,0.18)]">
      <header className="border-b border-[var(--color-border)] pb-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-widest text-[var(--color-accent)]"><FileText size={15} />{t(language, runMode === 'research' ? 'research.report.label' : 'research.report.artifact')}</div>
          <button
            type="button"
            onClick={() => void downloadReport()}
            disabled={saving}
            aria-label={t(language, 'research.report.download')}
            title={t(language, 'research.report.download')}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)] transition hover:border-[var(--color-accent)]/50 hover:text-[var(--color-accent)] disabled:cursor-wait disabled:opacity-60"
          >
            {saving ? <Loader2 size={13} className="animate-spin motion-reduce:animate-none" /> : saveStatus === 'saved' ? <Check size={13} /> : <Download size={13} />}
            {saving ? t(language, 'research.report.saving') : t(language, 'research.report.download')}
          </button>
        </div>
        <div aria-live="polite" className={`mt-1 min-h-4 text-right text-[10px] ${saveStatus === 'error' ? 'text-red-400' : 'text-[var(--color-accent)]'}`}>
          {saveStatus === 'saved' ? t(language, 'research.report.saved') : saveStatus === 'error' ? t(language, 'research.report.saveFailed') : ''}
        </div>
        <h2 className="mt-2 text-2xl font-semibold leading-tight text-[var(--color-text-primary)] [text-wrap:balance]">{report.title}</h2>
        <p className="mt-3 text-sm leading-6 text-[var(--color-text-secondary)] [text-wrap:pretty]">{report.summary}</p>
      </header>

      <div className="mt-6 space-y-7">
        {report.sections.map((section, sectionIndex) => (
          <section key={`${section.heading}-${sectionIndex}`}>
            <h3 className="text-lg font-semibold text-[var(--color-text-primary)] [text-wrap:balance]">{section.heading}</h3>
            <div className="mt-3 space-y-3">
              {section.paragraphs.map((paragraph, paragraphIndex) => (
                <p key={paragraphIndex} className="text-sm leading-7 text-[var(--color-text-secondary)] [text-wrap:pretty]">
                  {paragraph.text}{' '}{paragraph.citations.map((citation) => <CitationLink key={`${citation.sourceId}-${citation.quote}`} citation={citation} source={sources.get(citation.sourceId)} />)}
                </p>
              ))}
            </div>
          </section>
        ))}
      </div>

      {report.charts.length > 0 && <section className="mt-8 space-y-4" aria-labelledby="research-charts-heading"><h3 id="research-charts-heading" className="text-lg font-semibold text-[var(--color-text-primary)]">{t(language, 'research.charts')}</h3>{report.charts.map((chart, index) => <ResearchChart key={`${chart.title}-${index}`} chart={chart} />)}</section>}
      <SourceList sources={report.sources} />
    </article>
  )
}
