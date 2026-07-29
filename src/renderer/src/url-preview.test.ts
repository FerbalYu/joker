import test from 'node:test'
import assert from 'node:assert/strict'
import { compactUrl, linkLabel, splitUrls, classifyLink } from './url-preview'

void test('splitUrls keeps surrounding text and trailing punctuation', () => {
  assert.deepEqual(splitUrls('请看 https://example.com/a?x=1。'), [
    { type: 'text', value: '请看 ' },
    { type: 'url', value: 'https://example.com/a?x=1' },
    { type: 'text', value: '。' }
  ])
})

void test('splitUrls keeps non-http schemes as plain text', () => {
  assert.deepEqual(splitUrls('data:text/plain,x'), [
    { type: 'text', value: 'data:text/plain,x' }
  ])
})

void test('splitUrls recognizes local file links', () => {
  assert.deepEqual(splitUrls('打开 file:///E:/joker/README.md。'), [
    { type: 'text', value: '打开 ' },
    { type: 'url', value: 'file:///E:/joker/README.md' },
    { type: 'text', value: '。' }
  ])
})

void test('classifyLink distinguishes web, local Markdown, and unsafe links', () => {
  assert.deepEqual(classifyLink('https://example.com/readme.md'), { kind: 'web', isMarkdown: false })
  assert.deepEqual(classifyLink('file:///E:/joker/README.MD?line=1#intro'), { kind: 'file', isMarkdown: true })
  assert.deepEqual(classifyLink('file:///E:/joker/image.png'), { kind: 'file', isMarkdown: false })
  assert.deepEqual(classifyLink('javascript:alert(1)'), { kind: 'other', isMarkdown: false })
})

void test('linkLabel uses file names and compact web URLs', () => {
  assert.equal(linkLabel('file:///E:/joker/README.md'), 'README.md')
  assert.ok(linkLabel('https://example.com/'.padEnd(100, 'x')).length <= 64)
  assert.equal(linkLabel('javascript:alert(1)'), 'javascript:alert(1)')
})

void test('compactUrl keeps the host and shortens long paths', () => {
  const value = compactUrl('https://example.com/very/long/path/'.padEnd(140, 'x'), 48)
  assert.ok(value.length <= 48)
  assert.match(value, /^https:\/\/example\.com\//)
  assert.match(value, /…/)
})
