import test from 'node:test'
import assert from 'node:assert/strict'
import type { ChatMessage } from '@shared/types'
import {
  buildMinimapEntries,
  calculateViewportIndicator,
  minimapClickToScrollTop,
  truncatePreview
} from './message-minimap'

const message = (id: string, role: ChatMessage['role'], content = ''): ChatMessage => ({
  id,
  role,
  content,
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
