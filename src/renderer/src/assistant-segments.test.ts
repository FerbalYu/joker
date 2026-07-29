import test from 'node:test'
import assert from 'node:assert/strict'
import {
  appendTextSegment,
  appendToolSegment,
  flattenSegmentText,
  flattenToolCalls,
  segmentsFromLegacyMessage,
  updateToolInSegments
} from './assistant-segments'

void test('assistant segments keep text before tools and text after tools separate', () => {
  let segments = appendTextSegment([], '可以，我先查一下。')
  segments = appendToolSegment(segments, {
    toolCallId: '1',
    toolName: 'WebSearch',
    input: { query: 'grok' },
    status: 'running'
  })
  segments = appendToolSegment(segments, {
    toolCallId: '2',
    toolName: 'WebRead',
    input: { url: 'https://example.com' },
    status: 'running'
  })
  segments = appendTextSegment(segments, '查完了，结论如下。')

  assert.deepEqual(segments.map((segment) => segment.type), ['text', 'tools', 'text'])
  assert.equal(flattenSegmentText(segments), '可以，我先查一下。查完了，结论如下。')
  assert.equal(flattenToolCalls(segments).length, 2)
  assert.equal(segments[0]?.type === 'text' ? segments[0].text : '', '可以，我先查一下。')
  assert.equal(segments[2]?.type === 'text' ? segments[2].text : '', '查完了，结论如下。')
})

void test('assistant segments update tools by toolCallId without collapsing text boundaries', () => {
  let segments = appendTextSegment([], 'before')
  segments = appendToolSegment(segments, {
    toolCallId: 'a',
    toolName: 'WebSearch',
    input: {},
    status: 'running'
  })
  segments = updateToolInSegments(
    segments,
    (tool) => tool.toolCallId === 'a',
    (tool) => ({ ...tool, status: 'done', output: 'ok' })
  )
  segments = appendTextSegment(segments, 'after')

  assert.equal(segments[1]?.type === 'tools' ? segments[1].tools[0]?.status : '', 'done')
  assert.equal(segments[1]?.type === 'tools' ? segments[1].tools[0]?.output : '', 'ok')
  assert.equal(flattenSegmentText(segments), 'beforeafter')
})

void test('legacy messages place tools after content when timeline is unknown', () => {
  assert.deepEqual(
    segmentsFromLegacyMessage('final answer', [{ toolName: 'WebSearch', input: {}, status: 'done' }]),
    [
      { type: 'text', text: 'final answer' },
      { type: 'tools', tools: [{ toolName: 'WebSearch', input: {}, status: 'done' }] }
    ]
  )
})
