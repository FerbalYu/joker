import test from 'node:test'
import assert from 'node:assert/strict'
import { createResearchContext } from '../research/context'
import { presentResearchReportTool } from './research-report'
import type { ToolContext } from './registry'

function toolContext() {
  return {
    workspacePath: null,
    sessionId: 'research-session',
    runId: 'research-run',
    approvalGate: async () => ({ outcome: 'allow', risk: 'read', reason: 'test approval' }),
    researchContext: createResearchContext()
  } satisfies ToolContext
}

void test('PresentResearchReport injects authoritative registry sources', async () => {
  const context = toolContext()
  const source = context.researchContext.registerSource({
    url: 'https://example.com/article',
    title: 'Example article',
    text: 'This exact verified quote supports the finding.',
    retrievedAt: '2026-01-01T00:00:00Z'
  })
  const result = await presentResearchReportTool.execute({
    title: 'Report',
    summary: 'Summary',
    sections: [{
      heading: 'Finding',
      paragraphs: [{ text: 'Finding text.', citations: [{ sourceId: source.sourceId, quote: 'exact verified quote' }] }]
    }]
  }, context)

  const report = result.metadata?.researchReport as { sources?: Array<{ sourceId: string; url: string }> } | undefined
  assert.equal(report?.sources?.[0]?.sourceId, 'S1')
  assert.equal(report?.sources?.[0]?.url, 'https://example.com/article')
  assert.match(result.output, /accepted/)
})

void test('PresentResearchReport returns retryable output for invalid citations and source injection', async () => {
  const context = toolContext()
  context.researchContext.registerSource({ url: 'https://example.com/article', text: 'Known content only.' })

  const invalidQuote = await presentResearchReportTool.execute({
    title: 'Report',
    summary: 'Summary',
    sections: [{ heading: 'Finding', paragraphs: [{ text: 'Finding.', citations: [{ sourceId: 'S1', quote: 'invented quote' }] }] }]
  }, context)
  assert.equal(invalidQuote.metadata, undefined)
  assert.match(invalidQuote.output, /citation validation failed/)
  assert.match(invalidQuote.output, /call PresentResearchReport again/)

  const modelSources = await presentResearchReportTool.execute({
    title: 'Report',
    summary: 'Summary',
    sections: [{ heading: 'Finding', paragraphs: [{ text: 'Finding.', citations: [{ sourceId: 'S1', quote: 'Known content' }] }] }],
    sources: [{ sourceId: 'S1', url: 'https://attacker.invalid' }]
  }, context)
  assert.match(modelSources.output, /schema validation failed/)
})
