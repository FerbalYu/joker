import test from 'node:test'
import assert from 'node:assert/strict'
import type { ChatMessage } from '@shared/types'
import {
  buildMinimapEntries,
  calculateViewportIndicator,
  formatEntryDuration,
  minimapClickToScrollTop,
  truncatePreview
} from './message-minimap'

const message = (id: string, role: ChatMessage['role'], content = '', durationMs?: number): ChatMessage => ({
  id,
  role,
  content,
  ...(durationMs !== undefined ? { durationMs } : {}),
  createdAt: 1
})

void test('creates exactly one minimap entry per user message', () => {
  const entries = buildMinimapEntries([
    message('u1', 'user', '第一问'),
    message('a1', 'assistant', '第一答'),
    message('a2', 'assistant', '额外返回'),
    message('u2', 'user', '第二问'),
    message('a3', 'assistant', '第二答')
  ], '', false, 300)

  assert.equal(entries.length, 2)
  assert.deepEqual(entries.map((entry) => [entry.id, entry.userPreview, entry.replyPreview]), [
    ['u1', '第一问', '第一答'],
    ['u2', '第二问', '第二答']
  ])
})

void test('uses the streaming response for the current user entry', () => {
  const entries = buildMinimapEntries([
    message('u1', 'user', '当前问题')
  ], '正在返回的内容', true, 300)

  assert.equal(entries[0]?.replyPreview, '正在返回的内容')
})

void test('preview text is normalized and truncated after 20 characters', () => {
  assert.equal(truncatePreview('  一二三\n四五  '), '一二三 四五')
  assert.equal(truncatePreview('1234567890123456789012345'), '12345678901234567890....')
})

void test('many user messages stay inside the minimap track', () => {
  const messages = Array.from({ length: 80 }, (_, index) => message(`u${index}`, 'user', `问题${index}`))
  const entries = buildMinimapEntries(messages, '', false, 240)

  assert.equal(entries.length, 80)
  assert.ok(entries.every((entry) => entry.top >= 0 && entry.top + entry.height <= 241))
})

void test('viewport indicator maps top, bottom, and non-scrollable documents', () => {
  assert.deepEqual(calculateViewportIndicator(0, 100, 100, 300), { top: 0, height: 300 })

  const top = calculateViewportIndicator(0, 1000, 250, 400)
  const bottom = calculateViewportIndicator(750, 1000, 250, 400)
  assert.equal(top.top, 0)
  assert.equal(top.height, 100)
  assert.equal(bottom.top + bottom.height, 400)
})

void test('minimap clicks map to legal scroll positions', () => {
  assert.equal(minimapClickToScrollTop(0, 400, 100, 1000, 250), 0)
  assert.equal(minimapClickToScrollTop(400, 400, 100, 1000, 250), 750)
})

void test('recorded durations size timeline blocks proportionally and sum to the track', () => {
  const entries = buildMinimapEntries([
    message('u1', 'user', '慢问题'),
    message('a1', 'assistant', '慢答复', 9_000),
    message('u2', 'user', '快问题'),
    message('a2', 'assistant', '快答复', 1_000)
  ], '', false, 408)

  assert.equal(entries.length, 2)
  assert.equal(entries[0].durationMs, 9_000)
  assert.equal(entries[1].durationMs, 1_000)
  assert.ok(entries[0].height > entries[1].height * 3.5, `slow turn block is visibly larger (${entries[0].height} vs ${entries[1].height})`)
  const total = entries[entries.length - 1].top + entries[entries.length - 1].height
  assert.ok(total <= 409, `timeline stays inside the track (got ${total})`)
})

void test('unknown durations fall back to equal-height lines', () => {
  const entries = buildMinimapEntries([
    message('u1', 'user', '问题'),
    message('a1', 'assistant', '答复'),
    message('u2', 'user', '问题二'),
    message('a2', 'assistant', '答复二')
  ], '', false, 408)

  assert.equal(entries[0].height, entries[1].height)
  assert.equal(entries[0].durationMs, 0)
})

void test('tool calls are counted per turn and durations format compactly', () => {
  const entries = buildMinimapEntries([
    message('u1', 'user', '查一下'),
    {
      ...message('a1', 'assistant', '结果', 95_000),
      toolCalls: [
        { toolCallId: 't1', toolName: 'WebSearch', input: {}, status: 'done' as const, startedAt: 1 },
        { toolCallId: 't2', toolName: 'TodoWrite', input: {}, status: 'done' as const, startedAt: 2 },
        { toolCallId: 't3', toolName: 'ToolForgeStart', input: {}, status: 'done' as const, startedAt: 3 }
      ]
    }
  ], '', false, 408)

  assert.equal(entries[0].toolCount, 1, 'detail-only and internal tool calls are excluded')
  assert.equal(formatEntryDuration(950), '0.9s')
  assert.equal(formatEntryDuration(9_400), '9.4s')
  assert.equal(formatEntryDuration(10_400), '10s')
  assert.equal(formatEntryDuration(95_000), '1m 35s')
  assert.equal(formatEntryDuration(60_000), '1m')
  assert.equal(formatEntryDuration(0), '—')
})
