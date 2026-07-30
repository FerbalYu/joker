import test from 'node:test'
import assert from 'node:assert/strict'
import type { ChatMessage, ToolCallInfo } from '@shared/types'
import { deriveResearchProgress } from './research-progress'

const validReport = {
  title: 'Report',
  summary: 'Summary',
  sections: [{ heading: 'Findings', paragraphs: [{ text: 'Fact', citations: [{ sourceId: 'S1', quote: 'Fact' }] }] }],
  sources: [{ sourceId: 'S1', url: 'https://example.com', hostname: 'example.com', retrievedAt: '2026-01-01T00:00:00.000Z', contentHash: `sha256:${'a'.repeat(64)}` }]
}

const tool = (toolName: string, status: ToolCallInfo['status'] = 'done'): ToolCallInfo => ({
  toolName,
  input: {},
  status,
  ...(toolName === 'PresentResearchReport' && status === 'done' ? { metadata: { researchReport: validReport } } : {})
})

void test('deriveResearchProgress follows planning, searching, reading, synthesizing and completed stages', () => {
  assert.equal(deriveResearchProgress([], [], true, 'research')?.stage, 'planning')
  assert.equal(deriveResearchProgress([tool('WebSearch', 'running')], [], true, 'research')?.stage, 'searching')
  assert.equal(deriveResearchProgress([tool('WebSearch'), tool('WebRead', 'running')], [], true, 'research')?.stage, 'reading')
  assert.equal(deriveResearchProgress([tool('WebSearch'), tool('WebRead'), tool('PresentResearchReport', 'running')], [], true, 'research')?.stage, 'synthesizing')
  assert.deepEqual(deriveResearchProgress([tool('WebSearch'), tool('WebRead'), tool('PresentResearchReport')], [], false, 'research'), { stage: 'completed', searchCount: 1, readCount: 1 })
})

void test('deriveResearchProgress requires validated report metadata before completion', () => {
  const invalidReport = { ...tool('PresentResearchReport'), metadata: { researchReport: { title: 'invalid' } } }
  assert.equal(deriveResearchProgress([invalidReport], [], false, 'research')?.stage, 'synthesizing')
})

void test('deriveResearchProgress reports stopped and error states', () => {
  assert.equal(deriveResearchProgress([tool('WebRead', 'running')], [], false, 'research')?.stage, 'stopped')
  assert.equal(deriveResearchProgress([tool('WebSearch', 'error')], [], false, 'research')?.stage, 'error')
})

void test('deriveResearchProgress restores the latest historical research run only', () => {
  const messages: ChatMessage[] = [
    { id: 'chat', role: 'assistant', content: '', runMode: 'chat', toolCalls: [tool('WebSearch')], createdAt: 1 },
    { id: 'research', role: 'assistant', content: '', runMode: 'research', segments: [{ type: 'tools', tools: [tool('WebSearch'), tool('WebRead'), tool('PresentResearchReport')] }], createdAt: 2 }
  ]
  assert.equal(deriveResearchProgress([], messages, false, null)?.stage, 'completed')
  assert.equal(deriveResearchProgress([], [{ ...messages[0]!, runMode: 'chat' }], false, null), null)
})
