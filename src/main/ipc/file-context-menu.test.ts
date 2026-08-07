import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  buildFileContextMenuEntries,
  MAX_CLIPBOARD_FILE_BYTES,
  performFileContextAction,
  resolveFileContextTarget,
  type FileContextRuntime
} from './file-context-menu'

void test('resolveFileContextTarget strips line query and hash from file URLs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'joker-file-menu-'))
  const path = join(dir, 'sample file.txt')
  try {
    await writeFile(path, 'hello')
    const target = await resolveFileContextTarget(`${pathToFileURL(path).toString()}?line=12#L12`)
    assert.equal(target.path, path)
    assert.equal(target.size, 5)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

void test('file context menu exposes native Windows actions and disables oversized content copy', () => {
  const entries = buildFileContextMenuEntries('zh', { path: 'E:\\joker\\large.log', size: MAX_CLIPBOARD_FILE_BYTES + 1 }, 'win32')
  assert.deepEqual(entries.map((entry) => entry.type === 'separator' ? 'separator' : entry.action), [
    'open',
    'reveal',
    'open-with',
    'separator',
    'copy-path',
    'copy-contents'
  ])
  const copyContents = entries.find((entry) => entry.type === 'action' && entry.action === 'copy-contents')
  const openWith = entries.find((entry) => entry.type === 'action' && entry.action === 'open-with')
  assert.ok(copyContents?.type === 'action')
  assert.ok(openWith?.type === 'action')
  assert.equal(copyContents.enabled, false)
  assert.equal(copyContents.label, '复制文件内容（文件超过 2 MiB）')
  assert.equal(openWith.label, '打开方式…')
})

void test('copy path and contents use the validated absolute path', async () => {
  const writes: string[] = []
  const runtime = createRuntime(writes)
  const url = 'file:///E:/joker/example.ts?line=26'

  const pathResult = await performFileContextAction(url, 'copy-path', runtime)
  const contentResult = await performFileContextAction(url, 'copy-contents', runtime)

  assert.equal(pathResult.success, true)
  assert.equal(pathResult.path, 'E:\\joker\\example.ts')
  assert.equal(contentResult.success, true)
  assert.deepEqual(writes, ['E:\\joker\\example.ts', 'const ready = true\n'])
})

void test('file actions reject directories, oversized files, and binary content', async () => {
  const writes: string[] = []
  const directoryRuntime = createRuntime(writes, { isFile: false })
  assert.deepEqual(await performFileContextAction('file:///E:/joker/folder', 'copy-path', directoryRuntime), {
    success: false,
    action: 'copy-path',
    error: 'The target is not a file'
  })

  const largeRuntime = createRuntime(writes, { size: MAX_CLIPBOARD_FILE_BYTES + 1 })
  assert.equal((await performFileContextAction('file:///E:/joker/large.txt', 'copy-contents', largeRuntime)).error, 'File is too large to copy')

  const binaryRuntime = createRuntime(writes, { bytes: new Uint8Array([0, 1, 2]) })
  assert.equal((await performFileContextAction('file:///E:/joker/image.bin', 'copy-contents', binaryRuntime)).error, 'Only UTF-8 text files can be copied')
  assert.deepEqual(writes, [])
})

void test('missing local files return an actionable error before any operation', async () => {
  const runtime = createRuntime([])
  runtime.statFile = async () => {
    const error = new Error('missing') as Error & { code: string }
    error.code = 'ENOENT'
    throw error
  }
  assert.deepEqual(await performFileContextAction('file:///E:/joker/missing.txt', 'open', runtime), {
    success: false,
    action: 'open',
    error: 'File not found'
  })
})

void test('open surfaces shell failures and open-with stays Windows-only', async () => {
  const runtime = createRuntime([], { openError: 'No application is associated with this file' })
  assert.equal((await performFileContextAction('file:///E:/joker/file.unknown', 'open', runtime)).error, 'No application is associated with this file')

  const nonWindowsRuntime = { ...createRuntime([]), platform: 'linux' as const, openWith: undefined }
  assert.equal((await performFileContextAction('file:///E:/tmp/file.txt', 'open-with', nonWindowsRuntime)).error, 'Open with is only supported on Windows')
})

function createRuntime(
  writes: string[],
  overrides: { isFile?: boolean; size?: number; bytes?: Uint8Array; openError?: string } = {}
): FileContextRuntime {
  return {
    platform: 'win32',
    statFile: async () => ({ isFile: () => overrides.isFile ?? true, size: overrides.size ?? 19 }),
    readFileBytes: async () => overrides.bytes ?? new TextEncoder().encode('const ready = true\n'),
    openPath: async () => overrides.openError ?? '',
    revealPath: () => undefined,
    writeClipboardText: (value) => writes.push(value),
    openWith: async () => undefined
  }
}
