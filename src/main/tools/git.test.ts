import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitTools } from './git'
import type { ToolContext } from './registry'

const context = (workspacePath: string): ToolContext => ({ workspacePath, sessionId: 'git-test', approvalGate: async () => ({ outcome: 'allow', risk: 'read', reason: 'test approval' }) })

void test('GitStatus is a bounded read-only tool', async () => {
  const root = mkdtempSync(join(tmpdir(), 'joker-git-tool-'))
  try {
    const tool = gitTools.find((item) => item.name === 'GitStatus')!
    const result = await tool.execute({}, context(root))
    assert.match(result.output, /no output|not a git repository|fatal/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

void test('GitStatus refuses to use an implicit workspace', async () => {
  const tool = gitTools.find((item) => item.name === 'GitStatus')!
  const result = await tool.execute({}, { workspacePath: null, sessionId: 'git-no-workspace', approvalGate: async () => ({ outcome: 'allow', risk: 'read', reason: 'test approval' }) })
  assert.match(result.output, /No working folder selected/)
})

void test('GitLog input schema bounds the commit count', () => {
  const tool = gitTools.find((item) => item.name === 'GitLog')!
  assert.throws(() => tool.inputSchema.parse({ limit: 51 }))
  assert.equal(tool.inputSchema.parse({ limit: 10 }).limit, 10)
})
