import test from 'node:test'
import assert from 'node:assert/strict'
import type { ApprovalRequest } from '@shared/types'
import { ApprovalRegistry, cancelApprovalsForRun, cleanupApprovalWindow, createApprovalGate, evaluateToolPermission, getApprovalMode, getApprovalRegistry, resolveApproval, setApprovalMode, subscribeApprovalActivity, type ApprovalActivityEvent } from './approval'

function approvalRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    requestId: 'request-1',
    windowId: 1,
    sessionId: 's1',
    runId: 'r1',
    toolName: 'Bash',
    input: { command: 'whoami' },
    ...overrides
  }
}

void test('approval registry scopes resolution by window, session, and run', async () => {
  const registry = new ApprovalRegistry()
  const results: boolean[] = []
  registry.add(approvalRequest(), (value) => results.push(value))
  assert.equal(registry.resolve('request-1', { windowId: 2, sessionId: 's1', runId: 'r1' }, true), false)
  assert.equal(registry.resolve('request-1', { windowId: 1, sessionId: 's2', runId: 'r1' }, true), false)
  assert.equal(registry.resolve('request-1', { windowId: 1, sessionId: 's1', runId: 'r2' }, true), false)
  assert.equal(registry.resolve('request-1', { windowId: 1, sessionId: 's1', runId: 'r1' }, true), true)
  assert.deepEqual(results, [true])
})

void test('approval registry cancellation resolves pending approvals as denied', async () => {
  const registry = new ApprovalRegistry()
  const results: boolean[] = []
  registry.add(approvalRequest(), (value) => results.push(value))
  registry.cancelRun({ windowId: 1, sessionId: 's1', runId: 'r1' })
  assert.deepEqual(results, [false])
  assert.equal(registry.size, 0)
})

void test('pending approvals retain full requests and are scoped to their owning WebContents', () => {
  const registry = new ApprovalRegistry()
  const first = approvalRequest({
    requestId: 'request-owner-a',
    input: { command: 'x'.repeat(500) + '... [truncated]' }
  })
  const second = approvalRequest({
    requestId: 'request-owner-b',
    windowId: 2,
    sessionId: 's2',
    runId: 'r2',
    input: { path: 'C:/workspace' }
  })
  registry.add(first, () => {})
  registry.add(second, () => {})

  assert.deepEqual(registry.listPending(1), [first])
  assert.deepEqual(registry.listPending(2), [second])
  assert.deepEqual(registry.listPending(3), [])
  registry.cancelWindow(1)
  registry.cancelWindow(2)
})

void test('approval activity reports owner scope, retained request, and pending counts', () => {
  const registry = new ApprovalRegistry()
  const activity: ApprovalActivityEvent[] = []
  const unsubscribe = registry.subscribeActivity((event) => activity.push(event))
  const first = approvalRequest({ requestId: 'request-a' })
  const second = approvalRequest({ requestId: 'request-b', sessionId: 's2', runId: 'r2' })
  registry.add(first, () => {})
  registry.add(second, () => {})
  registry.resolve('request-a', { windowId: 1, sessionId: 's1', runId: 'r1' }, true)
  registry.cancel('request-b', { windowId: 1, sessionId: 's2', runId: 'r2' })
  unsubscribe()

  assert.deepEqual(activity.map(({ type, requestId, webContentsId, sessionId, runId, pendingCount, request }) => ({
    type, requestId, webContentsId, sessionId, runId, pendingCount, request
  })), [
    { type: 'pending', requestId: 'request-a', webContentsId: 1, sessionId: 's1', runId: 'r1', pendingCount: 1, request: first },
    { type: 'pending', requestId: 'request-b', webContentsId: 1, sessionId: 's2', runId: 'r2', pendingCount: 1, request: second },
    { type: 'resolved', requestId: 'request-a', webContentsId: 1, sessionId: 's1', runId: 'r1', pendingCount: 0, request: first },
    { type: 'cancelled', requestId: 'request-b', webContentsId: 1, sessionId: 's2', runId: 'r2', pendingCount: 0, request: second }
  ])
})

void test('approval activity observers cannot break approval resolution', () => {
  const registry = new ApprovalRegistry()
  const results: boolean[] = []
  registry.subscribeActivity(() => { throw new Error('observer failed') })
  registry.add(approvalRequest(), (approved) => results.push(approved))

  assert.equal(registry.resolve('request-1', { windowId: 1, sessionId: 's1', runId: 'r1' }, true), true)
  assert.deepEqual(results, [true])
})

void test('approval timeout removes the request and notifies the owner', async () => {
  const registry = new ApprovalRegistry(5)
  const resolved: boolean[] = []
  const terminal: unknown[] = []
  const request = approvalRequest({ requestId: 'request-timeout' })
  registry.add(request, (approved) => resolved.push(approved), (event) => terminal.push(event))

  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.deepEqual(resolved, [false])
  assert.deepEqual(terminal, [{ requestId: 'request-timeout', sessionId: 's1', runId: 'r1' }])
  assert.deepEqual(registry.listPending(1), [])
})

void test('research WebSearch and WebRead share one run-scoped approval', async () => {
  const sent: Array<{ requestId: string; toolName: string; input: Record<string, unknown> }> = []
  const win = {
    id: 170,
    isDestroyed: () => false,
    webContents: {
      id: 17,
      isDestroyed: () => false,
      send: (channel: string, request: { requestId: string; toolName: string; input: Record<string, unknown> }) => {
        if (channel === 'approval:request') sent.push(request)
      }
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
  const win = {
    id: 180,
    isDestroyed: () => false,
    webContents: { id: 18, isDestroyed: () => false, send: (...args: unknown[]) => sent.push(args) }
  }
  const gate = createApprovalGate(win as never, 'research-session', 'research-safe', 'research')
  assert.equal((await gate('PresentResearchReport', {})).outcome, 'allow')
  assert.equal(sent.length, 0)

  const denied = await gate('Bash', { command: 'whoami' })
  assert.equal(denied.outcome, 'deny')
  assert.equal(denied.reason, 'tool is unavailable in research mode')
  assert.equal(sent.length, 0)
})

void test('approval gate uses WebContents.id and accepts a response during send', async () => {
  const browserWindowId = 901
  const webContentsId = 902
  let resolveDuringSend = false
  let requestWindowId: number | undefined
  const win = {
    id: browserWindowId,
    isDestroyed: () => false,
    webContents: {
      id: webContentsId,
      isDestroyed: () => false,
      send: (channel: string, request: { requestId: string; windowId: number; sessionId: string; runId: string }) => {
        if (channel !== 'approval:request') return
        requestWindowId = request.windowId
        setApprovalMode('full-auto', webContentsId)
        resolveDuringSend = resolveApproval(request.requestId, true, {
          windowId: webContentsId,
          sessionId: request.sessionId,
          runId: request.runId
        })
      }
    }
  }

  const gate = createApprovalGate(win as never, 'identity-session', 'identity-run')
  setApprovalMode('auto-edit', browserWindowId)
  const result = await gate('Bash', { command: 'whoami' })
  assert.equal(requestWindowId, webContentsId)
  assert.equal(resolveDuringSend, true)
  assert.equal(result.outcome, 'allow')
  assert.equal(getApprovalMode(browserWindowId), 'full-auto')
  cleanupApprovalWindow(browserWindowId)
  assert.equal(getApprovalMode(webContentsId), 'suggest')
})

void test('main approval activity hook exposes owner and run lifecycle without renderer coupling', async () => {
  const activity: ApprovalActivityEvent[] = []
  const unsubscribe = subscribeApprovalActivity((event) => activity.push(event))
  const win = {
    id: 940,
    isDestroyed: () => false,
    webContents: {
      id: 941,
      isDestroyed: () => false,
      send: () => {}
    }
  }
  const pending = createApprovalGate(win as never, 'summary-session', 'summary-run')('Bash', { command: 'pwd' })
  const request = getApprovalRegistry().listPending(941)[0]!
  cancelApprovalsForRun({ windowId: 940, sessionId: 'summary-session', runId: 'summary-run' })
  await pending
  unsubscribe()

  assert.deepEqual(activity.map(({ type, webContentsId, sessionId, runId, pendingCount, request: retained }) => ({
    type, webContentsId, sessionId, runId, pendingCount, retained
  })), [
    { type: 'pending', webContentsId: 941, sessionId: 'summary-session', runId: 'summary-run', pendingCount: 1, retained: request },
    { type: 'cancelled', webContentsId: 941, sessionId: 'summary-session', runId: 'summary-run', pendingCount: 0, retained: request }
  ])
  cleanupApprovalWindow(940)
})

void test('approval gate retains the sanitized request and emits terminal removal to its owner', async () => {
  const sent: Array<{ channel: string; payload: unknown }> = []
  const win = {
    id: 930,
    isDestroyed: () => false,
    webContents: {
      id: 931,
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) => sent.push({ channel, payload })
    }
  }
  const gate = createApprovalGate(win as never, 'recovery-session', 'recovery-run')
  const pending = gate('Bash', { command: 'x'.repeat(501), nested: { untouched: true } })
  const request = sent[0]?.payload as ApprovalRequest

  assert.equal(sent[0]?.channel, 'approval:request')
  assert.equal(request.input.command, `${'x'.repeat(500)}... [truncated]`)
  assert.deepEqual(request.input.nested, { untouched: true })
  assert.deepEqual(getApprovalRegistry().listPending(931), [request])
  assert.equal(resolveApproval(request.requestId, false, {
    windowId: 931,
    sessionId: 'recovery-session',
    runId: 'recovery-run'
  }), true)
  assert.equal((await pending).outcome, 'deny')
  assert.deepEqual(sent[1], {
    channel: 'approval:resolved',
    payload: {
      requestId: request.requestId,
      sessionId: 'recovery-session',
      runId: 'recovery-run'
    }
  })
  cleanupApprovalWindow(930)
})

void test('approval gate removes pending request when send fails', async () => {
  const browserWindowId = 911
  const webContentsId = 912
  const win = {
    id: browserWindowId,
    isDestroyed: () => false,
    webContents: {
      id: webContentsId,
      isDestroyed: () => false,
      send: () => { throw new Error('renderer unavailable') }
    }
  }

  const result = await createApprovalGate(win as never, 'send-failure-session', 'send-failure-run')('Bash', { command: 'whoami' })
  assert.equal(result.outcome, 'deny')
  assert.equal(result.approvedByUser, false)
  assert.equal(getApprovalRegistry().size, 0)
  cleanupApprovalWindow(browserWindowId)
})

void test('BrowserWindow-id cleanup callers cancel WebContents-scoped pending requests', async () => {
  const browserWindowId = 921
  const webContentsId = 922
  let requestId = ''
  const win = {
    id: browserWindowId,
    isDestroyed: () => false,
    webContents: {
      id: webContentsId,
      isDestroyed: () => false,
      send: (_channel: string, request: { requestId: string }) => { requestId = request.requestId }
    }
  }

  const pending = createApprovalGate(win as never, 'cleanup-session', 'cleanup-run')('Bash', { command: 'whoami' })
  assert.notEqual(requestId, '')
  cancelApprovalsForRun({ windowId: browserWindowId, sessionId: 'cleanup-session', runId: 'cleanup-run' })
  assert.equal((await pending).outcome, 'deny')
  assert.equal(resolveApproval(requestId, true, { windowId: webContentsId, sessionId: 'cleanup-session', runId: 'cleanup-run' }), false)
  cleanupApprovalWindow(browserWindowId)
})

void test('explicit approval is sender and run bound and cannot be auto-approved by mode', async () => {
  const sent: ApprovalRequest[] = []
  const win = {
    id: 950,
    isDestroyed: () => false,
    webContents: {
      id: 951,
      isDestroyed: () => false,
      send: (channel: string, payload: ApprovalRequest) => {
        if (channel === 'approval:request') sent.push(payload)
      }
    }
  }
  setApprovalMode('full-auto', 951)
  const gate = createApprovalGate(win as never, 'promotion-session', 'promotion-run')
  const pending = gate.requestExplicitApproval!({
    toolName: 'GeneratedToolEnable',
    sessionId: 'promotion-session',
    runId: 'promotion-run',
    input: { promotionId: 'promotion-1' }
  })
  assert.equal(sent.length, 1)
  assert.equal(resolveApproval(sent[0]!.requestId, true, { windowId: 952, sessionId: 'promotion-session', runId: 'promotion-run' }), false)
  assert.equal(resolveApproval(sent[0]!.requestId, true, { windowId: 951, sessionId: 'promotion-session', runId: 'wrong-run' }), false)
  assert.equal(resolveApproval(sent[0]!.requestId, true, { windowId: 951, sessionId: 'promotion-session', runId: 'promotion-run' }), true)
  const grant = await pending
  assert.equal(grant?.webContentsId, 951)
  assert.equal(grant?.sessionId, 'promotion-session')
  assert.equal(grant?.runId, 'promotion-run')
  assert.match(grant?.requestHash ?? '', /^[a-f0-9]{64}$/)

  assert.equal(await gate.requestExplicitApproval!({
    toolName: 'GeneratedToolEnable',
    sessionId: 'spoofed-session',
    runId: 'promotion-run',
    input: {}
  }), null)
  cleanupApprovalWindow(950)
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
  assert.deepEqual(evaluateToolPermission('suggest', 'chat', 'ToolForgeStart'), {
    action: 'allow', risk: 'write_local', reason: 'host owns ToolForge lifecycle'
  })
  assert.deepEqual(evaluateToolPermission('full-auto', 'chat', 'generated-l1', {
    risk: 'read',
    source: {
      type: 'generated', toolId: 'tool-1', name: 'Tool 1', versionId: 'v1', fingerprint: 'a'.repeat(64),
      validationReportId: 'report-1', pointerRevision: 1, capabilityRevision: 1, runtimeQualificationLevel: 'L1', validationProfile: 'gate2-project-read-v1'
    }
  }), {
    action: 'ask', risk: 'read', reason: 'L1 Generated Tool execution requires approval'
  })
  assert.deepEqual(evaluateToolPermission('full-auto', 'chat', 'generated-l2', {
    risk: 'read',
    source: {
      type: 'generated', toolId: 'tool-1', name: 'Tool 1', versionId: 'v1', fingerprint: 'a'.repeat(64),
      validationReportId: 'report-1', pointerRevision: 1, capabilityRevision: 1, runtimeQualificationLevel: 'L2', validationProfile: 'gate2-project-read-v1'
    }
  }), {
    action: 'allow', risk: 'read', reason: 'read-only tool'
  })
  assert.deepEqual(evaluateToolPermission('full-auto', 'chat', 'generated-full-trust', {
    risk: 'write_local',
    source: {
      type: 'generated', toolId: 'tool-1', name: 'Tool 1', versionId: 'v1', fingerprint: 'a'.repeat(64),
      validationReportId: 'report-1', pointerRevision: 1, capabilityRevision: 1,
      runtimeQualificationLevel: 'L1', validationProfile: 'user-owned-full-trust-v1'
    }
  }), {
    action: 'allow', risk: 'write_local', reason: 'active workspace full trust authorizes this Generated Tool'
  })
})
