import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fileUrlToLocalPath } from './file-path'
import {
  ensureMarkdownExtension,
  markdownExportFilename,
  markdownExportWithinLimit,
  writeMarkdownExport,
  MAX_MARKDOWN_EXPORT_BYTES
} from './file-export'

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

void test('markdownExportFilename sanitizes Windows filenames and preserves unicode', () => {
  assert.equal(markdownExportFilename('市场：2026/Q3?'), '市场-2026-Q3.md')
  assert.equal(markdownExportFilename('CON'), '_CON.md')
  assert.equal(markdownExportFilename('NUL.txt'), '_NUL.txt.md')
  assert.equal(markdownExportFilename('Report.md'), 'Report.md')
  assert.equal(markdownExportFilename('...'), 'research-report.md')
  assert.equal(markdownExportFilename('研究报告 🚀'), '研究报告 🚀.md')
})

void test('markdownExportFilename bounds long names without splitting unicode', () => {
  const name = markdownExportFilename('😀'.repeat(200))
  assert.equal(Array.from(name.replace(/\.md$/, '')).length, 120)
  assert.ok(name.endsWith('.md'))
})

void test('ensureMarkdownExtension appends md exactly once', () => {
  assert.equal(ensureMarkdownExtension('E:\\Reports\\report'), 'E:\\Reports\\report.md')
  assert.equal(ensureMarkdownExtension('E:\\Reports\\report.MD'), 'E:\\Reports\\report.MD')
})

void test('markdownExportWithinLimit measures UTF-8 bytes at the export boundary', () => {
  assert.equal(markdownExportWithinLimit('a'.repeat(MAX_MARKDOWN_EXPORT_BYTES)), true)
  assert.equal(markdownExportWithinLimit('a'.repeat(MAX_MARKDOWN_EXPORT_BYTES + 1)), false)
  assert.equal(markdownExportWithinLimit('研'.repeat(Math.floor(MAX_MARKDOWN_EXPORT_BYTES / 3))), true)
  assert.equal(markdownExportWithinLimit(`研${'a'.repeat(MAX_MARKDOWN_EXPORT_BYTES - 2)}`), false)
})

void test('writeMarkdownExport writes exact UTF-8 Markdown and returns the normalized path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'joker-markdown-export-'))
  try {
    const content = '# 研究报告 🚀\n\n完整内容。\n'
    const path = await writeMarkdownExport(join(dir, 'report'), content)
    assert.equal(path, join(dir, 'report.md'))
    assert.equal(await readFile(path, 'utf8'), content)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
