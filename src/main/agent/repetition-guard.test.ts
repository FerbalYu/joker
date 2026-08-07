import test from 'node:test'
import assert from 'node:assert/strict'
import { detectRepetitionLoop } from './repetition-guard'

void test('detects a repeated two-line model degeneration loop', () => {
  const match = detectRepetitionLoop('继续。\n下一步。\n'.repeat(4))
  assert.deepEqual(match, { pattern: ['继续。', '下一步。'], repetitions: 4 })
})

void test('requires more repetitions for very short one-unit loops', () => {
  assert.equal(detectRepetitionLoop('继续。\n'.repeat(7)), null)
  assert.deepEqual(detectRepetitionLoop('继续。\n'.repeat(8)), { pattern: ['继续。'], repetitions: 8 })
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
