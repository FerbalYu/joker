import test from 'node:test'
import assert from 'node:assert/strict'
import { ApprovalRegistry, createApprovalGate, evaluateToolPermission, resolveApproval } from './approval'

void test('approval registry scopes resolution by window, session, and run', async () => {
  const registry = new ApprovalRegistry()
  const results: boolean[] = []
  registry.add({ windowId: 1, sessionId: 's1', runId: 'r1' }, 'request-1', (value) => results.push(value))
  assert.equal(registry.resolve('request-1', { windowId: 2, sessionId: 's1', runId: 'r1' }, true), false)
  assert.equal(registry.resolve('request-1', { windowId: 1, sessionId: 's2', runId: 'r1' }, true), false)
  assert.equal(registry.resolve('request-1', { windowId: 1, sessionId: 's1', runId: 'r2' }, true), false)
  assert.equal(registry.resolve('request-1', { windowId: 1, sessionId: 's1', runId: 'r1' }, true), true)
  assert.deepEqual(results, [true])
})

void test('approval registry cancellation resolves pending approvals as denied', async () => {
  const registry = new ApprovalRegistry()
  const results: boolean[] = []
  registry.add({ windowId: 1, sessionId: 's1', runId: 'r1' }, 'request-1', (value) => results.push(value))
  registry.cancelRun({ windowId: 1, sessionId: 's1', runId: 'r1' })
  assert.deepEqual(results, [false])
  assert.equal(registry.size, 0)
})

void test('research WebSearch and WebRead share one run-scoped approval', async () => {
  const sent: Array<{ requestId: string; toolName: string; input: Record<string, unknown> }> = []
  const win = {
    id: 17,
    webContents: {
      send: (_channel: string, request: { requestId: string; toolName: string; input: Record<string, unknown> }) => sent.push(request)
    }
  }
  const gate = createApprovalGate(win as never, 'research-session', 'research-run', 'research')
  const first = gate('WebSearch', { query: 'topic' })
  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.toolName, 'ResearchWebAccess')
  assert.deepEqual(sent[0]?.input.tools, ['WebSearch', 'WebRead'])
  assert.equal(resolveApproval(sent[0]!.requestId, true, { windowId: 17, sessionId: 'research-session', runId: 'research-run' }), true)
  assert.equal((await first).outcome, 'allow')
  assert.equal((await gate('WebRead', { url: 'https://example.com' })).outcome, 'allow')
  assert.equal(sent.length, 1)

  const nextRunGate = createApprovalGate(win as never, 'research-session', 'research-run-2', 'research')
  const nextRun = nextRunGate('WebRead', { url: 'https://example.com' })
  assert.equal(sent.length, 2)
  assert.equal(resolveApproval(sent[1]!.requestId, false, { windowId: 17, sessionId: 'research-session', runId: 'research-run-2' }), true)
  assert.equal((await nextRun).outcome, 'deny')
})

void test('PresentResearchReport is always safe but other research tools are not approved', async () => {
  const sent: unknown[] = []
  const win = { id: 18, webContents: { send: (...args: unknown[]) => sent.push(args) } }
  const gate = createApprovalGate(win as never, 'research-session', 'research-safe', 'research')
  assert.equal((await gate('PresentResearchReport', {})).outcome, 'allow')
  assert.equal(sent.length, 0)

  const denied = await gate('Bash', { command: 'whoami' })
  assert.equal(denied.outcome, 'deny')
  assert.equal(denied.reason, 'tool is unavailable in research mode')
  assert.equal(sent.length, 0)
})

void test('permission decisions are risk-based and retain mode boundaries', () => {
  assert.deepEqual(evaluateToolPermission('suggest', 'chat', 'Read'), {
    action: 'allow', risk: 'read', reason: 'read-only tool'
  })
  assert.deepEqual(evaluateToolPermission('auto-edit', 'chat', 'Write'), {
    action: 'allow', risk: 'write_local', reason: 'auto-edit mode'
  })
  assert.deepEqual(evaluateToolPermission('auto-edit', 'chat', 'Bash'), {
    action: 'ask', risk: 'exec', reason: 'exec tool requires approval'
  })
  assert.deepEqual(evaluateToolPermission('full-auto', 'chat', 'mcp_files_read', { source: { type: 'mcp' } }), {
    action: 'allow', risk: 'external', reason: 'full-auto mode'
  })
})
