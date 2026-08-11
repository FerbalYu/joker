import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { globTool, grepTool } from './grep'
import type { ToolContext } from './registry'

function context(workspacePath: string, abortSignal?: AbortSignal): ToolContext {
  return {
    workspacePath,
    sessionId: 'search-test',
    approvalGate: async () => ({ outcome: 'allow', risk: 'read', reason: 'test' }),
    abortSignal
  }
}

test('Glob double-star traversal advances without duplicate matches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'joker-glob-'))
  try {
    await mkdir(join(root, 'src', 'deep'), { recursive: true })
    await writeFile(join(root, 'root.ts'), 'root')
    await writeFile(join(root, 'src', 'one.ts'), 'one')
    await writeFile(join(root, 'src', 'deep', 'two.ts'), 'two')
    await writeFile(join(root, 'src', 'deep', 'skip.js'), 'skip')

    const result = await globTool.execute({ pattern: '**/*.ts' }, context(root))
    const matches = result.output.split('\n').sort()
    assert.deepEqual(matches, ['root.ts', 'src/deep/two.ts', 'src/one.ts'])
    assert.equal(new Set(matches).size, matches.length)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Grep and Glob reject immediately when cancelled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'joker-search-abort-'))
  try {
    await writeFile(join(root, 'fixture.txt'), 'needle')
    const controller = new AbortController()
    controller.abort(new Error('search cancelled'))
    await assert.rejects(grepTool.execute({ pattern: 'needle' }, context(root, controller.signal)), /cancelled/)
    await assert.rejects(globTool.execute({ pattern: '**/*' }, context(root, controller.signal)), /cancelled/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
