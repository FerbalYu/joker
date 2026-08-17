import test from 'node:test'
import assert from 'node:assert/strict'
import { detectRepetitionLoop, ToolCallRepetitionGuard, TOOL_REPEAT_GENTLE_REMINDER } from './repetition-guard'

void test('detects a repeated two-line model degeneration loop', () => {
  const match = detectRepetitionLoop('继续。\n下一步。\n'.repeat(4))
  assert.deepEqual(match, { pattern: ['继续。', '下一步。'], repetitions: 4, truncateAt: 0 })
})

void test('requires more repetitions for very short one-unit loops', () => {
  assert.equal(detectRepetitionLoop('继续。\n'.repeat(7)), null)
  assert.deepEqual(detectRepetitionLoop('继续。\n'.repeat(8)), { pattern: ['继续。'], repetitions: 8, truncateAt: 0 })
})

void test('ignores normal prose and non-identical task lists', () => {
  assert.equal(detectRepetitionLoop([
    '第一步：读取项目。',
    '第二步：修改代码。',
    '第三步：运行测试。',
    '第四步：检查结果。',
    '第五步：交付说明。'
  ].join('\n')), null)
})

void test('reports the truncation offset after useful leading content', () => {
  const prefix = '直接说，我马上改。'
  const match = detectRepetitionLoop(prefix + '随时可以继续优化。'.repeat(3))
  assert.deepEqual(match, { pattern: ['随时可以继续优化。'], repetitions: 3, truncateAt: prefix.length })
})

void test('stops earlier on the third consecutive repeat', () => {
  const match = detectRepetitionLoop('随时可以继续优化。'.repeat(3))
  assert.deepEqual(match, { pattern: ['随时可以继续优化。'], repetitions: 3, truncateAt: 0 })
})

void test('tool repetition guard canonicalizes nested object key order', () => {
  const guard = new ToolCallRepetitionGuard()
  guard.observe('Read', { b: 2, nested: { y: null, x: [1, 2] } })
  guard.observe('Read', { nested: { x: [1, 2], y: null }, b: 2 })
  const third = guard.observe('Read', { b: 2, nested: { y: null, x: [1, 2] } })
  assert.equal(third.count, 3)
  assert.equal(third.reminder, TOOL_REPEAT_GENTLE_REMINDER)
})

void test('tool repetition guard resets for different tools or arguments', () => {
  const guard = new ToolCallRepetitionGuard()
  guard.observe('Read', { filePath: 'a' })
  guard.observe('Read', { filePath: 'a' })
  assert.deepEqual(guard.observe('Read', { filePath: 'b' }), { count: 1 })
  assert.deepEqual(guard.observe('Grep', { filePath: 'b' }), { count: 1 })
})

void test('tool repetition guard details and truncates the fifth call preview', () => {
  const guard = new ToolCallRepetitionGuard()
  const input = { body: 'x'.repeat(700) }
  let observation = guard.observe('Write', input)
  for (let index = 1; index < 5; index += 1) observation = guard.observe('Write', input)
  assert.equal(observation.count, 5)
  assert.match(observation.reminder ?? '', /consecutive_calls: 5/)
  assert.match(observation.reminder ?? '', /… \(\+\d+ more chars\)/)
  assert.ok((observation.reminder ?? '').length < 900)
})
