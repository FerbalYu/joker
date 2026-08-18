import test from 'node:test'
import assert from 'node:assert/strict'
import { isSessionRuntimeBusy, useStore } from './store'
import type { ChatMessage, StreamUsage } from '@shared/types'

const sessionA = 'session-a'
const sessionB = 'session-b'

function resetStore(): void {
  useStore.setState({
    messages: [],
    sessionRuntimes: {},
    activeSessionId: null,
    approvalQueue: [],
    selectedApproval: null
  })
  useStore.getState().setActiveSession(sessionA)
}

void test('selected UI projects its session runtime while background streams remain isolated', () => {
  resetStore()
  useStore.getState().startStream(sessionA)
  useStore.getState().appendToken(sessionA, 'foreground')
  useStore.getState().startStream(sessionB)
  useStore.getState().appendToken(sessionB, 'background')

  assert.equal(useStore.getState().streamText, 'foreground')
  assert.equal(useStore.getState().sessionRuntimes[sessionB]?.streamText, 'background')

  useStore.getState().setActiveSession(sessionB)
  assert.equal(useStore.getState().streamText, 'background')
  assert.equal(useStore.getState().streaming, true)

  useStore.getState().appendToken(sessionA, ' update')
  assert.equal(useStore.getState().streamText, 'background')
  assert.equal(useStore.getState().sessionRuntimes[sessionA]?.streamText, 'foreground update')
})

void test('token batches update multiple session runtimes in one store notification', () => {
  resetStore()
  useStore.getState().startStream(sessionA)
  useStore.getState().startStream(sessionB)
  let notifications = 0
  const unsubscribe = useStore.subscribe(() => { notifications += 1 })

  useStore.getState().appendTokenBatch([
    { sessionId: sessionA, runId: 'run-a', text: 'hello' },
    { sessionId: sessionA, runId: 'run-a', text: ' world' },
    { sessionId: sessionB, runId: 'run-b', text: 'background' }
  ])
  unsubscribe()

  assert.equal(notifications, 1)
  assert.equal(useStore.getState().streamText, 'hello world')
  assert.equal(useStore.getState().runActivity.phase, 'streaming-text')
  assert.equal(useStore.getState().sessionRuntimes[sessionB]?.streamText, 'background')
  assert.equal(useStore.getState().sessionRuntimes[sessionB]?.runActivity.phase, 'streaming-text')
})

void test('reset and completion only clear the target session runtime', () => {
  resetStore()
  useStore.getState().startStream(sessionA)
  useStore.getState().appendToken(sessionA, 'a')
  useStore.getState().startStream(sessionB)
  useStore.getState().appendToken(sessionB, 'b')
  useStore.getState().resetTransientState(sessionA)

  assert.equal(useStore.getState().sessionRuntimes[sessionA]?.streaming, false)
  assert.equal(useStore.getState().sessionRuntimes[sessionB]?.streamText, 'b')
})

void test('store persists usage and run mode on committed assistant messages', () => {
  resetStore()
  useStore.getState().setStreamRunMode(sessionA, 'research')
  useStore.getState().startStream(sessionA)
  useStore.getState().appendToken(sessionA, 'report')
  const usage: StreamUsage = { inputTokens: 12, outputTokens: 4, totalTokens: 16 }
  const message = useStore.getState().commitStream(sessionA, 'assistant-research', usage)
  assert.equal(message?.runMode, 'research')
  assert.deepEqual(message?.usage, usage)
  assert.deepEqual(useStore.getState().messages.at(-1)?.usage, usage)
})

void test('tool results and pending messages are scoped by session', () => {
  resetStore()
  useStore.getState().startStream(sessionA)
  useStore.getState().startStream(sessionB)
  useStore.getState().addPendingToolCall(sessionA, { toolCallId: 'call-a', toolName: 'Read', input: {}, status: 'running' })
  useStore.getState().addPendingToolCall(sessionB, { toolCallId: 'call-b', toolName: 'Read', input: {}, status: 'running' })
  useStore.getState().resolveToolCall(sessionB, 'call-b', 'Read', 'second')
  useStore.getState().setPendingUserMessages(sessionB, [{
    mode: 'queue',
    status: 'queued',
    message: { id: 'queued-1', role: 'user', content: 'follow up', createdAt: 1 },
    sequence: 1,
    createdAt: 1
  }])

  assert.equal(useStore.getState().sessionRuntimes[sessionA]?.pendingToolCalls[0]?.status, 'running')
  assert.equal(useStore.getState().sessionRuntimes[sessionB]?.pendingToolCalls[0]?.output, 'second')
  assert.equal(useStore.getState().sessionRuntimes[sessionB]?.pendingUserMessages[0]?.message.id, 'queued-1')
  assert.deepEqual(useStore.getState().pendingUserMessages, [])
})

void test('tool result enriches an earlier terminal status without allowing stale heartbeats to revive it', () => {
  resetStore()
  useStore.getState().startStream(sessionA)
  useStore.getState().addPendingToolCall(sessionA, {
    toolCallId: 'forge-call',
    toolName: 'ToolForgeStart',
    input: { spec: { id: 'tool-1' } },
    status: 'running'
  })
  useStore.getState().updateToolStatus(sessionA, {
    toolCallId: 'forge-call',
    toolName: 'ToolForgeStart',
    input: {},
    status: 'done',
    startedAt: 10,
    updatedAt: 20,
    lastProgressAt: 20,
    deadlineAt: 100,
    durationMs: 10
  })
  useStore.getState().resolveToolCall(
    sessionA,
    'forge-call',
    'ToolForgeStart',
    '{"jobId":"job-1","status":"queued"}',
    { forge: true },
    { startedAt: 10, updatedAt: 21, durationMs: 11 }
  )
  useStore.getState().updateToolStatus(sessionA, {
    toolCallId: 'forge-call',
    toolName: 'ToolForgeStart',
    input: {},
    status: 'running',
    updatedAt: 15
  })

  const tool = useStore.getState().sessionRuntimes[sessionA]?.pendingToolCalls[0]
  assert.equal(tool?.status, 'done')
  assert.equal(tool?.output, '{"jobId":"job-1","status":"queued"}')
  assert.deepEqual(tool?.metadata, { forge: true })
  assert.deepEqual(tool?.input, { spec: { id: 'tool-1' } })
  assert.equal(tool?.updatedAt, 21)
})

void test('sub-agent activity updates remain isolated by session and replace the same run', () => {
  resetStore()
  const base = {
    id: 'subagent-1',
    task: 'Inspect data flow',
    status: 'queued' as const,
    phase: 'queued' as const,
    createdAt: 1,
    updatedAt: 1,
    currentStep: 0,
    maxSteps: 20,
    tools: []
  }
  useStore.getState().updateSubagentActivity(sessionB, base)
  useStore.getState().updateSubagentActivity(sessionB, { ...base, status: 'running', phase: 'working', updatedAt: 2, currentStep: 1 })

  assert.deepEqual(useStore.getState().subagentActivities, [])
  assert.equal(useStore.getState().sessionRuntimes[sessionB]?.subagentActivities.length, 1)
  assert.equal(useStore.getState().sessionRuntimes[sessionB]?.subagentActivities[0]?.status, 'running')
})

void test('background approval changes only the matching runtime activity', () => {
  resetStore()
  useStore.getState().dispatchRunActivity(sessionA, { type: 'send-accepted', runId: 'run-a', sessionId: sessionA, runMode: 'chat' })
  useStore.getState().dispatchRunActivity(sessionB, { type: 'send-accepted', runId: 'run-b', sessionId: sessionB, runMode: 'chat' })
  useStore.getState().addApproval({
    requestId: 'approval-b',
    windowId: 1,
    runId: 'run-b',
    sessionId: sessionB,
    toolName: 'Bash',
    input: {}
  })

  assert.equal(useStore.getState().runActivity.phase, 'starting')
  assert.equal(useStore.getState().sessionRuntimes[sessionB]?.runActivity.phase, 'awaiting-approval')
  assert.equal(useStore.getState().selectedApproval, null)
  useStore.getState().setActiveSession(sessionB)
  assert.equal(useStore.getState().selectedApproval?.requestId, 'approval-b')
  assert.equal(useStore.getState().runActivity.phase, 'awaiting-approval')
})

void test('pending approval snapshots hydrate and resolved approvals clear runtime state', () => {
  resetStore()
  useStore.getState().dispatchRunActivity(sessionB, { type: 'send-accepted', runId: 'run-b', sessionId: sessionB, runMode: 'chat' })
  useStore.getState().setApprovals([{
    requestId: 'approval-b',
    windowId: 1,
    runId: 'run-b',
    sessionId: sessionB,
    toolName: 'Bash',
    input: {}
  }])
  assert.equal(useStore.getState().sessionRuntimes[sessionB]?.runActivity.phase, 'awaiting-approval')
  useStore.getState().removeApproval('approval-b')
  assert.equal(useStore.getState().approvalQueue.length, 0)
  assert.equal(useStore.getState().sessionRuntimes[sessionB]?.runActivity.phase, 'waiting-model')
})

void test('session summary upserts and deletes stay incremental', () => {
  resetStore()
  const summary = {
    id: sessionA,
    title: 'A',
    createdAt: 1,
    updatedAt: 2,
    activity: {
      status: 'completed' as const,
      unread: true,
      terminalRevision: 1,
      seenTerminalRevision: 0,
      pendingApprovalCount: 0
    }
  }
  useStore.getState().upsertSessionSummary(summary)
  useStore.getState().upsertSessionSummary({ ...summary, title: 'Updated' })
  assert.equal(useStore.getState().sessions.length, 1)
  assert.equal(useStore.getState().sessions[0]?.title, 'Updated')
  useStore.getState().removeSessionSummary(sessionA)
  assert.equal(useStore.getState().sessions.length, 0)
})

void test('target-session gating only treats that session runtime as busy', () => {
  resetStore()
  useStore.getState().startStream(sessionA)
  assert.equal(isSessionRuntimeBusy(useStore.getState().sessionRuntimes[sessionA]), true)
  assert.equal(isSessionRuntimeBusy(useStore.getState().sessionRuntimes[sessionB]), false)
  useStore.getState().setSendStarting(sessionB, true)
  assert.equal(isSessionRuntimeBusy(useStore.getState().sessionRuntimes[sessionB]), true)
})

void test('messages remain selected-session data while runtime state is keyed', () => {
  resetStore()
  const message: ChatMessage = { id: 'm1', role: 'user', content: 'hello', createdAt: 1 }
  useStore.getState().setMessages([message])
  useStore.getState().startStream(sessionB)
  assert.deepEqual(useStore.getState().messages, [message])
})

void test('renderer ToolCall updates are monotonic after terminal states', () => {
  useStore.getState().resetTransientState('session-a')
  useStore.getState().addPendingToolCall('session-a', { toolCallId: 'call-terminal', toolName: 'Write', input: {}, status: 'running' })
  useStore.getState().resolveToolCall('session-a', 'call-terminal', 'Write', 'denied', { terminalStatus: 'denied' })
  useStore.getState().updateToolStatus('session-a', { toolCallId: 'call-terminal', toolName: 'Write', input: {}, status: 'running', updatedAt: Date.now() + 1 })
  assert.equal(useStore.getState().pendingToolCalls.find((item) => item.toolCallId === 'call-terminal')?.status, 'denied')
})
