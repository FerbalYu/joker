import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { fileUrlToLocalPath } from './file-path'

void test('fileUrlToLocalPath accepts encoded Windows file paths', () => {
  assert.equal(
    fileUrlToLocalPath('file:///E:/joker/My%20Notes.md'),
    fileURLToPath('file:///E:/joker/My%20Notes.md')
  )
})

void test('fileUrlToLocalPath ignores query and hash fragments', () => {
  assert.equal(
    fileUrlToLocalPath('file:///E:/joker/README.md?line=1#intro'),
    fileURLToPath('file:///E:/joker/README.md')
  )
})
