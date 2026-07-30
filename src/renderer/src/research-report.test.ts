import test from 'node:test'
import assert from 'node:assert/strict'
import { chartTable, parseResearchReportMetadata, serializeResearchReportMarkdown } from './research-report'

const source = { sourceId: 'S1', url: 'https://example.com/a', hostname: 'example.com', retrievedAt: '2026-01-01T00:00:00.000Z', contentHash: `sha256:${'b'.repeat(64)}` }
const base = { title: 'Report', summary: 'Summary', sections: [{ heading: 'Section', paragraphs: [{ text: 'Fact', citations: [{ sourceId: 'S1', quote: 'Fact' }] }] }], sources: [source] }

void test('parseResearchReportMetadata accepts schema reports and adds bounded chart tables', () => {
  const result = parseResearchReportMetadata({ researchReport: { ...base, charts: [{ type: 'bar', title: 'Values', sourceIds: ['S1'], data: [{ label: 'A', value: 2 }] }] } })
  assert.equal(result.success, true)
  if (result.success) assert.deepEqual(result.report.charts[0]?.table.rows, [['A', 2]])
})

void test('parseResearchReportMetadata rejects arbitrary ECharts option-shaped input', () => {
  const result = parseResearchReportMetadata({ researchReport: { ...base, charts: [{ type: 'bar', title: 'Values', sourceIds: ['S1'], data: [{ label: 'A', value: 2 }], tooltip: { formatter: '<b>x</b>' } }] } })
  assert.deepEqual(result, { success: false, error: 'invalid-research-report' })
})

void test('chartTable produces a scatter data fallback', () => {
  assert.deepEqual(chartTable({ type: 'scatter', title: 'Scatter', sourceIds: ['S1'], xLabel: 'Speed', yLabel: 'Cost', data: [{ x: 1, y: 2, label: 'A' }] }), {
    columns: ['Speed', 'Cost', 'Label'],
    rows: [[1, 2, 'A']]
  })
})

void test('serializeResearchReportMarkdown preserves sections, citations, charts, and sources', () => {
  const result = parseResearchReportMetadata({
    researchReport: {
      ...base,
      title: 'Report *Title*',
      summary: 'Summary with <markup>',
      sections: [{ heading: 'Section | One', paragraphs: [{ text: '# Fact [one]', citations: [{ sourceId: 'S1', quote: 'Fact | quote' }] }] }],
      charts: [{ type: 'bar', title: 'Values', sourceIds: ['S1'], data: [{ label: 'A | B', value: 2 }] }]
    }
  })
  assert.equal(result.success, true)
  if (!result.success) return
  const markdown = serializeResearchReportMarkdown(result.report)
  assert.match(markdown, /^# Report \\\*Title\\\*/)
  assert.match(markdown, /Summary with \\<markup\\>/)
  assert.match(markdown, /## Section \| One/)
  assert.ok(markdown.includes('\\# Fact \\[one\\] [S1](<https://example.com/a>)'))
  assert.match(markdown, /> \*\*\[S1\] Quote:\*\* “Fact \| quote”/)
  assert.match(markdown, /\| A \\\| B \| 2 \|/)
  assert.match(markdown, /S1\. \*\*example\.com\*\*/)
  assert.match(markdown, /Content SHA-256:/)
  assert.ok(markdown.endsWith('\n'))
  assert.equal(serializeResearchReportMarkdown(result.report), markdown)
})

void test('serializeResearchReportMarkdown omits the chart section when no charts exist', () => {
  const result = parseResearchReportMetadata({ researchReport: { ...base, charts: [] } })
  assert.equal(result.success, true)
  if (!result.success) return
  const markdown = serializeResearchReportMarkdown(result.report)
  assert.doesNotMatch(markdown, /## Charts/)
  assert.match(markdown, /## Sources/)
})
