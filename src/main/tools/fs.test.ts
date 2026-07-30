import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { editTool } from './fs'
import type { ToolContext } from './registry'

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'joker-fs-tool-'))
  try {
    await run(workspace)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

function context(workspacePath: string): ToolContext {
  return {
    workspacePath,
    sessionId: 'fs-test',
    approvalGate: async () => ({ outcome: 'allow', risk: 'read', reason: 'test approval' })
  }
}

void test('Edit reports added and deleted line counts', async () => {
  await withWorkspace(async (workspace) => {
    const filePath = join(workspace, 'sample.txt')
    await writeFile(filePath, 'alpha\nbeta\ngamma\n', 'utf8')

    const result = await editTool.execute({
      filePath,
      oldString: 'beta\n',
      newString: 'beta updated\ndelta\n'
    }, context(workspace))

    assert.equal(result.metadata?.additions, 2)
    assert.equal(result.metadata?.deletions, 1)
    assert.equal(await readFile(filePath, 'utf8'), 'alpha\nbeta updated\ndelta\ngamma\n')
  })
})

void test('Edit counts inserted blank lines from diff metadata', async () => {
  await withWorkspace(async (workspace) => {
    const filePath = join(workspace, 'blank-line.txt')
    await writeFile(filePath, 'alpha\nbeta\n', 'utf8')

    const result = await editTool.execute({
      filePath,
      oldString: 'alpha\n',
      newString: 'alpha\n\n'
    }, context(workspace))

    assert.equal(result.metadata?.additions, 1)
    assert.equal(result.metadata?.deletions, 0)
    assert.match(String(result.metadata?.diff), /^@@ /)
    assert.match(String(result.metadata?.diff), /^\+$/m)
  })
})

void test('Edit diff includes exactly two context lines around a middle change', async () => {
  await withWorkspace(async (workspace) => {
    const filePath = join(workspace, 'context.txt')
    await writeFile(filePath, `${Array.from({ length: 9 }, (_, index) => `line ${index + 1}`).join('\n')}\n`, 'utf8')

    const result = await editTool.execute({
      filePath,
      oldString: 'line 5',
      newString: 'line five'
    }, context(workspace))
    const diff = String(result.metadata?.diff)

    assert.match(diff, /^@@ -3,5 \+3,5 @@/)
    assert.match(diff, / line 3\n line 4\n-line 5\n\+line five\n line 6\n line 7/)
    assert.doesNotMatch(diff, /line 2/)
    assert.doesNotMatch(diff, /line 8/)
  })
})

void test('Edit diff separates distant replacements into multiple hunks', async () => {
  await withWorkspace(async (workspace) => {
    const filePath = join(workspace, 'multiple-hunks.txt')
    const content = Array.from(
      { length: 20 },
      (_, index) => index === 2 || index === 16 ? 'changed marker' : `line ${index + 1}`
    ).join('\n')
    await writeFile(filePath, `${content}\n`, 'utf8')

    const result = await editTool.execute({
      filePath,
      oldString: 'changed marker',
      newString: 'replacement',
      replaceAll: true
    }, context(workspace))
    const diff = String(result.metadata?.diff)
    const hunkCount = diff.split('\n').filter((line) => line.startsWith('@@ ')).length

    assert.equal(hunkCount, 2)
    assert.equal(result.metadata?.additions, 2)
    assert.equal(result.metadata?.deletions, 2)
    assert.doesNotMatch(diff, /line 10/)
  })
})
