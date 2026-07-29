import test from 'node:test'
import assert from 'node:assert/strict'
import { bashTool } from './bash'
import type { ToolContext } from './registry'

const context = (abortSignal?: AbortSignal): ToolContext => ({
  workspacePath: process.cwd(),
  sessionId: 'bash-test',
  approvalGate: async () => true,
  abortSignal
})

test('Bash returns stdout and stderr with exit status', async () => {
  const result = await bashTool.execute({ command: 'node -e "process.stdout.write(\\\"out\\\"); process.stderr.write(\\\"err\\\"); process.exit(3)"' }, context())
  assert.match(result.output, /out/)
  assert.match(result.output, /\[stderr\] err/)
  assert.match(result.output, /\[exit code: 3\]/)
})

test('Bash bounds output and marks truncation', async () => {
  const result = await bashTool.execute({ command: 'node -e "process.stdout.write(\\\"x\\\".repeat(1100000))"' }, context())
  assert.equal(result.metadata?.truncated, true)
  assert.match(result.output, /output truncated: 1 MiB limit/)
})

test('Bash terminates on abort with explicit semantics', async () => {
  const controller = new AbortController()
  const promise = bashTool.execute({ command: 'node -e "setTimeout(() => {}, 30000)"', timeout: 30000 }, context(controller.signal))
  setTimeout(() => controller.abort(), 50)
  const result = await promise
  assert.equal(result.metadata?.reason, 'aborted')
  assert.match(result.output, /\[aborted\]/)
})

test('Bash reports timeout distinctly', async () => {
  const result = await bashTool.execute({ command: 'node -e "setTimeout(() => {}, 30000)"', timeout: 50 }, context())
  assert.equal(result.metadata?.reason, 'timeout')
  assert.match(result.output, /\[timed out\]/)
})
