import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setOperationsDirForTests, spillToolResult } from '../store/operations'
import { toolResultReadTool } from './tool-result-read'

void test('ToolResultRead is session-owned, read-only, and uses byte cursors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'joker-spill-tool-'))
  setOperationsDirForTests(dir)
  try {
    const spill = spillToolResult('session-a', 'call-a', '中文🙂'.repeat(40_000))
    assert.ok(spill)
    const result = await toolResultReadTool.execute({ spillId: spill.id, offsetBytes: 0, limitBytes: 128 }, { sessionId: 'session-a', workspacePath: null } as never)
    const parsed = JSON.parse(result.output)
    assert.equal(parsed.offsetBytes, 0)
    assert.equal(parsed.contentBytes <= 132, true)
    assert.equal(parsed.nextOffsetBytes > 0, true)
    await assert.rejects(() => toolResultReadTool.execute({ spillId: spill.id }, { sessionId: 'session-b', workspacePath: null } as never), /not found/)
    assert.equal(toolResultReadTool.retrySemantics, 'read-only')
    assert.equal(toolResultReadTool.executionMode, 'parallel-read')
    const tiny = await toolResultReadTool.execute({ spillId: spill.id, offsetBytes: 0, limitBytes: 1 }, { sessionId: 'session-a', workspacePath: null } as never)
    const tinyPage = JSON.parse(tiny.output)
    assert.equal(tinyPage.nextOffsetBytes > 0, true)
    let cursor = 0
    let reconstructed = ''
    for (let page = 0; page < 100_000; page += 1) {
      const part = await toolResultReadTool.execute({ spillId: spill.id, offsetBytes: cursor, limitBytes: 997 }, { sessionId: 'session-a', workspacePath: null } as never)
      const data = JSON.parse(part.output)
      reconstructed += data.content
      if (data.eof) break
      assert.equal(data.nextOffsetBytes > cursor, true)
      cursor = data.nextOffsetBytes
    }
    assert.equal(reconstructed, '中文🙂'.repeat(40_000))
  } finally { setOperationsDirForTests(null); rmSync(dir, { recursive: true, force: true }) }
})
