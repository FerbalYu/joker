import test from 'node:test'
import assert from 'node:assert/strict'
import { extractResearchReports, visibleChatTools } from './tool-visibility'

const validReport = {
  title: 'Report',
  summary: 'Summary',
  sections: [{ heading: 'Findings', paragraphs: [{ text: 'Fact', citations: [{ sourceId: 'S1', quote: 'Fact' }] }] }],
  sources: [{ sourceId: 'S1', url: 'https://example.com/a', hostname: 'example.com', retrievedAt: '2026-01-01T00:00:00.000Z', contentHash: `sha256:${'a'.repeat(64)}` }]
}

void test('visibleChatTools removes detail-only and report-artifact tools', () => {
  const tools = visibleChatTools([
    { toolName: 'Read', input: {}, status: 'done' },
    { toolName: 'TodoWrite', input: { todos: [] }, status: 'done' },
    { toolName: 'PresentResearchReport', input: {}, status: 'done', metadata: { researchReport: validReport } },
    { toolName: 'Bash', input: {}, status: 'running' }
  ])
  assert.deepEqual(tools.map((tool) => tool.toolName), ['Read', 'Bash'])
})

void test('extractResearchReports returns valid and invalid artifacts without throwing', () => {
  const reports = extractResearchReports([
    { toolName: 'PresentResearchReport', input: {}, status: 'done', metadata: { researchReport: validReport } },
    { toolName: 'PresentResearchReport', input: {}, status: 'done', metadata: { researchReport: { title: '<script>' } } },
    { toolName: 'WebRead', input: {}, status: 'done' }
  ])
  assert.equal(reports.length, 2)
  assert.equal(reports[0]?.report?.title, 'Report')
  assert.equal(reports[0]?.error, null)
  assert.equal(reports[1]?.report, null)
  assert.equal(reports[1]?.error, 'invalid-research-report')
})
