import test from 'node:test'
import assert from 'node:assert/strict'
import { appendSpillChunk, getToolResultSpill, initialSpillReadState } from './tool-spill'

void test('Spill metadata accepts only bounded identity and size fields', () => {
  const id = 'a'.repeat(64)
  assert.deepEqual(getToolResultSpill({
    spill: { id, bytes: 128.9, sha256: 'b'.repeat(64), preview: 'short', truncated: true }
  }), {
    id,
    bytes: 128,
    sha256: 'b'.repeat(64),
    preview: 'short',
    truncated: true
  })
  assert.equal(getToolResultSpill({ spill: { id: '../escape', bytes: 1 } }), null)
  assert.equal(getToolResultSpill({ spill: { id, bytes: -1 } }), null)
})

void test('Spill chunks append with UTF-8 byte cursors until EOF', () => {
  const first = appendSpillChunk(initialSpillReadState, {
    content: '你a',
    totalBytes: 7,
    offsetBytes: 0,
    contentBytes: 4,
    nextOffsetBytes: 4,
    eof: false
  })
  assert.deepEqual(first, {
    content: '你a',
    loadedBytes: 4,
    nextOffsetBytes: 4,
    totalBytes: 7,
    eof: false
  })
  const complete = appendSpillChunk(first, {
    content: '好',
    totalBytes: 7,
    offsetBytes: 4,
    contentBytes: 3,
    eof: true
  })
  assert.equal(complete.content, '你a好')
  assert.equal(complete.loadedBytes, 7)
  assert.equal(complete.eof, true)
})

void test('Spill chunks reject stale offsets, invalid byte counts, cursor stalls, and inconsistent EOF', () => {
  assert.throws(() => appendSpillChunk(initialSpillReadState, {
    content: 'x', totalBytes: 1, offsetBytes: 1, contentBytes: 1, eof: true
  }), /offset mismatch/)
  assert.throws(() => appendSpillChunk(initialSpillReadState, {
    content: '你', totalBytes: 3, offsetBytes: 0, contentBytes: 1, eof: true
  }), /byte length mismatch/)
  assert.throws(() => appendSpillChunk(initialSpillReadState, {
    content: '', totalBytes: 1, offsetBytes: 0, contentBytes: 0, nextOffsetBytes: 0, eof: false
  }), /did not advance/)
  assert.throws(() => appendSpillChunk(initialSpillReadState, {
    content: 'x', totalBytes: 2, offsetBytes: 0, contentBytes: 1, nextOffsetBytes: 1, eof: true
  }), /EOF does not match cursor/)
})
