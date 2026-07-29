import test from 'node:test'
import assert from 'node:assert/strict'
import { base64ByteSize, getImageResizeDimensions, validateChatParts } from './messages'

void test('calculates proportional image resize dimensions without upscaling', () => {
  assert.deepEqual(getImageResizeDimensions(4000, 3000), { width: 1280, height: 960, resized: true })
  assert.deepEqual(getImageResizeDimensions(3000, 4000), { width: 960, height: 1280, resized: true })
  assert.deepEqual(getImageResizeDimensions(1280, 1280), { width: 1280, height: 1280, resized: false })
  assert.deepEqual(getImageResizeDimensions(640, 480), { width: 640, height: 480, resized: false })
})
void test('validates text and image message parts', () => {
  const data = Buffer.from('tiny-image').toString('base64')
  assert.equal(base64ByteSize(data), 10)
  assert.equal(validateChatParts([{ type: 'text', text: 'look' }, { type: 'image', data, mediaType: 'image/png', sizeBytes: 10 }]), true)
  assert.equal(validateChatParts([{ type: 'image', data, mediaType: 'image/svg+xml' }]), false)
})

void test('rejects malformed and oversized image parts', () => {
  assert.equal(validateChatParts([{ type: 'image', data: 'not base64!', mediaType: 'image/png' }]), false)
  assert.equal(validateChatParts([{ type: 'image', data: Buffer.from('tiny').toString('base64'), mediaType: 'image/png', sizeBytes: 99 }]), false)
})
