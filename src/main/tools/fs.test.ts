import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { editTool, readTool, writeTool } from './fs'
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

void test('Read returns a version digest that is stable for identical content', async () => {
  await withWorkspace(async (workspace) => {
    const filePath = join(workspace, 'versioned.txt')
    await writeFile(filePath, 'alpha\nbeta\n', 'utf8')

    const first = await readTool.execute({ filePath }, context(workspace))
    const second = await readTool.execute({ filePath }, context(workspace))

    assert.equal(typeof first.metadata?.version, 'string')
    assert.equal(String(first.metadata?.version).length, 64)
    assert.equal(first.metadata?.version, second.metadata?.version)
  })
})

void test('Read version changes when the file content changes', async () => {
  await withWorkspace(async (workspace) => {
    const filePath = join(workspace, 'versioned.txt')
    await writeFile(filePath, 'alpha\n', 'utf8')

    const before = await readTool.execute({ filePath }, context(workspace))
    await writeFile(filePath, 'beta\n', 'utf8')
    const after = await readTool.execute({ filePath }, context(workspace))

    assert.notEqual(before.metadata?.version, after.metadata?.version)
  })
})

void test('Edit with a matching expectedVersion succeeds', async () => {
  await withWorkspace(async (workspace) => {
    const filePath = join(workspace, 'cas.txt')
    await writeFile(filePath, 'alpha\nbeta\ngamma\n', 'utf8')
    const read = await readTool.execute({ filePath }, context(workspace))

    const result = await editTool.execute({
      filePath,
      oldString: 'beta\n',
      newString: 'beta updated\n',
      expectedVersion: read.metadata?.version as string
    }, context(workspace))

    assert.equal(result.metadata?.additions, 1)
    assert.equal(await readFile(filePath, 'utf8'), 'alpha\nbeta updated\ngamma\n')
  })
})

void test('Edit with a stale expectedVersion fails and leaves the file untouched', async () => {
  await withWorkspace(async (workspace) => {
    const filePath = join(workspace, 'cas.txt')
    await writeFile(filePath, 'alpha\nbeta\ngamma\n', 'utf8')
    const stale = await readTool.execute({ filePath }, context(workspace))
    await writeFile(filePath, 'changed by someone else\n', 'utf8')

    await assert.rejects(
      editTool.execute({
        filePath,
        oldString: 'beta\n',
        newString: 'beta updated\n',
        expectedVersion: stale.metadata?.version as string
      }, context(workspace)),
      /expectedVersion mismatch/
    )

    assert.equal(await readFile(filePath, 'utf8'), 'changed by someone else\n')
  })
})

void test('Write over an existing file with a matching expectedVersion succeeds', async () => {
  await withWorkspace(async (workspace) => {
    const filePath = join(workspace, 'overwrite.txt')
    await writeFile(filePath, 'original\n', 'utf8')
    const read = await readTool.execute({ filePath }, context(workspace))

    const result = await writeTool.execute({
      filePath,
      content: 'replacement\n',
      expectedVersion: read.metadata?.version as string
    }, context(workspace))

    assert.equal(await readFile(filePath, 'utf8'), 'replacement\n')
    assert.equal(typeof result.metadata?.version, 'string')
  })
})

void test('Write with a stale expectedVersion fails and preserves the existing file', async () => {
  await withWorkspace(async (workspace) => {
    const filePath = join(workspace, 'overwrite.txt')
    await writeFile(filePath, 'original\n', 'utf8')
    const stale = await readTool.execute({ filePath }, context(workspace))
    await writeFile(filePath, 'someone else wrote this\n', 'utf8')

    await assert.rejects(
      writeTool.execute({
        filePath,
        content: 'replacement\n',
        expectedVersion: stale.metadata?.version as string
      }, context(workspace)),
      /expectedVersion mismatch/
    )

    assert.equal(await readFile(filePath, 'utf8'), 'someone else wrote this\n')
  })
})

void test('Write without expectedVersion keeps the existing overwrite behavior', async () => {
  await withWorkspace(async (workspace) => {
    const filePath = join(workspace, 'overwrite.txt')
    await writeFile(filePath, 'original\n', 'utf8')

    const result = await writeTool.execute({ filePath, content: 'replacement\n' }, context(workspace))

    assert.equal(await readFile(filePath, 'utf8'), 'replacement\n')
    assert.equal(typeof result.metadata?.version, 'string')
  })
})

void test('Write creates a new file (create-if-absent) with a version', async () => {
  await withWorkspace(async (workspace) => {
    const filePath = join(workspace, 'nested', 'new.txt')

    const result = await writeTool.execute({ filePath, content: 'created\n' }, context(workspace))

    assert.equal(await readFile(filePath, 'utf8'), 'created\n')
    assert.equal(typeof result.metadata?.version, 'string')
  })
})
