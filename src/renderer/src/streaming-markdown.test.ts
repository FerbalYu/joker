import test from 'node:test'
import assert from 'node:assert/strict'
import { partitionStreamingMarkdown } from './streaming-markdown'

void test('freezes completed markdown blocks and leaves the active tail unparsed', () => {
  assert.deepEqual(partitionStreamingMarkdown('first paragraph\n\nsecond'), {
    blocks: ['first paragraph\n\n'],
    tail: 'second'
  })
})

void test('does not split on blank lines inside fenced code', () => {
  assert.deepEqual(partitionStreamingMarkdown('```ts\nconst a = 1\n\nconst b = 2\n```\n\nafter'), {
    blocks: ['```ts\nconst a = 1\n\nconst b = 2\n```\n\n'],
    tail: 'after'
  })
})

void test('keeps an unfinished fenced block in the live tail', () => {
  assert.deepEqual(partitionStreamingMarkdown('before\n\n```ts\nconst a = 1'), {
    blocks: ['before\n\n'],
    tail: '```ts\nconst a = 1'
  })
})
