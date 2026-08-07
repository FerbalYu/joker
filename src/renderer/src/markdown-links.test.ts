import test from 'node:test'
import assert from 'node:assert/strict'
import { markdownUrlTransform } from './markdown-links'

void test('markdown URL transform preserves validated file URLs for FileLink rendering', () => {
  assert.equal(
    markdownUrlTransform('file:///E:/joker/src/main/ipc/file-context-menu.ts?line=1'),
    'file:///E:/joker/src/main/ipc/file-context-menu.ts?line=1'
  )
})

void test('markdown URL transform keeps the default unsafe-protocol rejection', () => {
  assert.equal(markdownUrlTransform('javascript:alert(1)'), '')
  assert.equal(markdownUrlTransform('https://example.com/docs'), 'https://example.com/docs')
})
