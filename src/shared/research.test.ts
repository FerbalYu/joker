import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ResearchReportDraftSchema,
  ResearchReportSchema,
  parseResearchReport
} from './research'

const draft = {
  title: 'Verified report',
  summary: 'A bounded summary.',
  sections: [{
    heading: 'Finding',
    paragraphs: [{ text: 'The finding is supported.', citations: [{ sourceId: 'S1', quote: 'supported text' }] }]
  }],
  charts: [{ type: 'bar' as const, title: 'Values', sourceIds: ['S1'], data: [{ label: 'A', value: 2 }] }]
}

const source = {
  sourceId: 'S1',
  url: 'https://example.com/article',
  title: 'Example',
  hostname: 'example.com',
  retrievedAt: '2026-01-01T00:00:00.000Z',
  contentHash: `sha256:${'a'.repeat(64)}`
}

void test('research draft rejects model-authored sources and unknown fields', () => {
  assert.equal(ResearchReportDraftSchema.safeParse(draft).success, true)
  assert.equal(ResearchReportDraftSchema.safeParse({ ...draft, sources: [source] }).success, false)
  assert.equal(ResearchReportDraftSchema.safeParse({ ...draft, extra: true }).success, false)
})

void test('normalized research report accepts injected sources and supported chart types', () => {
  const report = parseResearchReport({ ...draft, sources: [source] })
  assert.equal(report.sources[0]?.url, source.url)
  for (const type of ['bar', 'line', 'pie', 'scatter'] as const) {
    const data = type === 'scatter'
      ? [{ x: 1, y: 2 }]
      : type === 'line'
        ? [{ label: 'A', value: 1 }, { label: 'B', value: 2 }]
        : [{ label: 'A', value: 1 }]
    assert.equal(ResearchReportSchema.safeParse({ ...draft, charts: [{ type, title: type, sourceIds: ['S1'], data }], sources: [source] }).success, true)
  }
})

void test('research schema enforces bounded arrays and citation source ids', () => {
  const paragraphs = Array.from({ length: 25 }, (_, index) => ({
    text: `paragraph ${index}`,
    citations: [{ sourceId: 'S1', quote: 'quote' }]
  }))
  assert.equal(ResearchReportDraftSchema.safeParse({ ...draft, sections: [{ heading: 'Too many', paragraphs }] }).success, false)
  assert.equal(ResearchReportDraftSchema.safeParse({
    ...draft,
    sections: [{ heading: 'Bad source', paragraphs: [{ text: 'text', citations: [{ sourceId: 'https://example.com', quote: 'quote' }] }] }]
  }).success, false)
})
