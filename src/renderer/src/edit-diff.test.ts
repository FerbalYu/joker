import test from 'node:test'
import assert from 'node:assert/strict'
import { getEditDiffPreview } from './edit-diff'

void test('legacy Edit diff infers additions and deletions', () => {
  const preview = getEditDiffPreview({
    diff: ' first\n-old\n+new\n+extra\n last'
  })

  assert.equal(preview.additions, 2)
  assert.equal(preview.deletions, 1)
})

void test('legacy Edit diff keeps only two lines around a change', () => {
  const diff = Array.from({ length: 12 }, (_, index) => {
    if (index === 6) return '-old line'
    if (index === 7) return '+new line'
    return ` line ${index + 1}`
  }).join('\n')
  const preview = getEditDiffPreview({ diff })

  assert.match(preview.text, /^…\n line 5\n line 6\n-old line\n\+new line\n line 9\n line 10\n…$/)
  assert.doesNotMatch(preview.text, /line 4/)
  assert.doesNotMatch(preview.text, /line 11/)
})

void test('legacy Edit diff preserves distant changes as separate fragments', () => {
  const diff = Array.from({ length: 20 }, (_, index) => {
    if (index === 3 || index === 16) return '-old'
    if (index === 4 || index === 17) return '+new'
    return ` line ${index + 1}`
  }).join('\n')
  const preview = getEditDiffPreview({ diff })

  assert.equal(preview.additions, 2)
  assert.equal(preview.deletions, 2)
  assert.equal(preview.text.split('\n').filter((line) => line === '…').length, 2)
  assert.match(preview.text, / line 2\n line 3\n-old\n\+new\n line 6\n line 7/)
  assert.match(preview.text, / line 15\n line 16\n-old\n\+new\n line 19\n line 20/)
  assert.doesNotMatch(preview.text, /line 10/)
})

void test('structured Edit diff remains unchanged and uses explicit counts', () => {
  const diff = '@@ -3,5 +3,5 @@\n line 3\n line 4\n-old\n+new\n line 6\n line 7'
  const preview = getEditDiffPreview({
    diff,
    additions: 4,
    deletions: 3
  })

  assert.equal(preview.text, diff)
  assert.equal(preview.additions, 4)
  assert.equal(preview.deletions, 3)
})

void test('structured Edit diff can infer counts without counting file headers', () => {
  const preview = getEditDiffPreview({
    diff: '--- old.txt\n+++ new.txt\n@@ -1,1 +1,1 @@\n-old\n+new'
  })

  assert.equal(preview.additions, 1)
  assert.equal(preview.deletions, 1)
})

void test('legacy Edit diff counts source lines beginning with triple signs when no header separator follows', () => {
  const preview = getEditDiffPreview({
    diff: ' context\n---actual source line\n+++actual source line\n context'
  })

  assert.equal(preview.additions, 1)
  assert.equal(preview.deletions, 1)
})

void test('invalid Edit metadata is handled safely', () => {
  assert.deepEqual(getEditDiffPreview(undefined), {
    text: '',
    additions: 0,
    deletions: 0
  })
  assert.deepEqual(getEditDiffPreview({ diff: 42, additions: -1, deletions: '2' }), {
    text: '',
    additions: 0,
    deletions: 0
  })
})
