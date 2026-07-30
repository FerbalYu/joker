import { ResearchReportSchema, type ResearchChart, type ResearchReport } from '../../shared/research'

export type ResearchChartTable = {
  columns: string[]
  rows: Array<Array<string | number>>
}

export type SafeResearchChart = ResearchChart & {
  table: ResearchChartTable
}

export interface SafeResearchReport extends Omit<ResearchReport, 'charts'> {
  charts: SafeResearchChart[]
}

export type ResearchReportParseResult =
  | { success: true; report: SafeResearchReport }
  | { success: false; error: 'invalid-research-report' }

export function parseResearchReportMetadata(metadata: Record<string, unknown> | undefined): ResearchReportParseResult {
  const parsed = ResearchReportSchema.safeParse(metadata?.researchReport)
  if (!parsed.success) return { success: false, error: 'invalid-research-report' }
  return {
    success: true,
    report: {
      ...parsed.data,
      charts: (parsed.data.charts ?? []).map((chart) => ({
        ...chart,
        table: chartTable(chart)
      }))
    }
  }
}

export function chartTable(chart: ResearchChart): ResearchChartTable {
  if (chart.type === 'scatter') {
    return {
      columns: [chart.xLabel ?? 'X', chart.yLabel ?? 'Y', 'Label'],
      rows: chart.data.map((point) => [point.x, point.y, point.label ?? ''])
    }
  }
  return {
    columns: ['Label', 'Value'],
    rows: chart.data.map((point) => [point.label, point.value])
  }
}

export function serializeResearchReportMarkdown(report: SafeResearchReport): string {
  const sources = new Map(report.sources.map((source) => [source.sourceId, source]))
  const lines: string[] = [`# ${escapeMarkdownText(report.title)}`, '', escapeMarkdownText(report.summary), '']

  for (const section of report.sections) {
    lines.push(`## ${escapeMarkdownText(section.heading)}`, '')
    for (const paragraph of section.paragraphs) {
      const citations = paragraph.citations.map((citation) => {
        const source = sources.get(citation.sourceId)
        return source ? `[${citation.sourceId}](<${escapeMarkdownUrl(source.url)}>)` : `[${citation.sourceId}]`
      }).join(' ')
      lines.push(`${escapeMarkdownText(paragraph.text)}${citations ? ` ${citations}` : ''}`, '')
      for (const citation of paragraph.citations) {
        lines.push(`> **[${citation.sourceId}] Quote:** “${escapeMarkdownText(citation.quote)}”`, '')
      }
    }
  }

  if (report.charts.length > 0) {
    lines.push('## Charts', '')
    for (const chart of report.charts) {
      lines.push(`### ${escapeMarkdownText(chart.title)}`, '', `- Type: \`${chart.type}\``)
      if ('xLabel' in chart && chart.xLabel) lines.push(`- X axis: ${escapeMarkdownText(chart.xLabel)}`)
      if ('yLabel' in chart && chart.yLabel) lines.push(`- Y axis: ${escapeMarkdownText(chart.yLabel)}`)
      const sourceLinks = chart.sourceIds.map((sourceId) => {
        const source = sources.get(sourceId)
        return source ? `[${sourceId}](<${escapeMarkdownUrl(source.url)}>)` : `[${sourceId}]`
      }).join(', ')
      lines.push(`- Sources: ${sourceLinks}`, '')
      lines.push(`| ${chart.table.columns.map(escapeMarkdownTableCell).join(' | ')} |`)
      lines.push(`| ${chart.table.columns.map(() => '---').join(' | ')} |`)
      for (const row of chart.table.rows) lines.push(`| ${row.map((value) => escapeMarkdownTableCell(String(value))).join(' | ')} |`)
      lines.push('')
    }
  }

  lines.push('## Sources', '')
  for (const source of report.sources) {
    lines.push(`${source.sourceId}. **${escapeMarkdownText(source.title ?? source.hostname)}**`)
    lines.push(`   - URL: <${escapeMarkdownUrl(source.url)}>`)
    lines.push(`   - Host: \`${escapeMarkdownCode(source.hostname)}\``)
    lines.push(`   - Retrieved: \`${escapeMarkdownCode(source.retrievedAt)}\``)
    lines.push(`   - Content SHA-256: \`${escapeMarkdownCode(source.contentHash)}\``, '')
  }

  return `${lines.join('\n').trimEnd()}\n`
}

function escapeMarkdownText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/([`*_\[\]<>])/g, '\\$1')
    .replace(/^(\s*)(#{1,6}|>|[-+*]|\d+[.)])\s/gm, '$1\\$2 ')
}

function escapeMarkdownTableCell(value: string): string {
  return escapeMarkdownText(value).replace(/\|/g, '\\|')
}

function escapeMarkdownUrl(value: string): string {
  return value.replace(/[<>\s]/g, (character) => encodeURIComponent(character))
}

function escapeMarkdownCode(value: string): string {
  return value.replace(/`/g, 'ˋ')
}
