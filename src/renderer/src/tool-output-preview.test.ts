import test from 'node:test'
import assert from 'node:assert/strict'
import { getToolOutputPreview, READ_PREVIEW_LINES } from './tool-output-preview'

void test('Read preview keeps short file output unchanged', () => {
  const output = '     1\talpha\n     2\tbeta'
  assert.deepEqual(getToolOutputPreview('Read', output, 'zh'), {
    text: output,
    truncated: false,
    shownLines: 2,
    totalLines: 2
  })
})

void test('Read preview shows only the first twenty lines', () => {
  const output = Array.from({ length: 25 }, (_, index) => `${String(index + 1).padStart(6)}\tline ${index + 1}`).join('\n')
  const preview = getToolOutputPreview('Read', output, 'zh')

  assert.equal(preview.truncated, true)
  assert.equal(preview.shownLines, READ_PREVIEW_LINES)
  assert.equal(preview.totalLines, 25)
  assert.match(preview.text, /line 20/)
  assert.doesNotMatch(preview.text, /line 21/)
  assert.match(preview.text, /仅显示前 20 行，共 25 行/)
})

void test('other tool output keeps the general character limit', () => {
  const preview = getToolOutputPreview('Bash', 'x'.repeat(2001), 'en')
  assert.equal(preview.truncated, true)
  assert.match(preview.text, /\[truncated\]$/)
})
