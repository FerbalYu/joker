import { BrowserWindow, MessageChannelMain } from 'electron'
import { runAgent } from './agent/loop'
import { createApprovalGate, cancelApprovalsForRun, cleanupApprovalWindow } from './agent/approval'
import { buildToolSet, type ToolDefinition, type ToolContext } from './tools/registry'
import { fsTools } from './tools/fs'
import { bashTools } from './tools/bash'
import { searchTools } from './tools/grep'
import { buildToolForgeMetaTools } from './tools/tool-forge'
import { todoTools } from './tools/todo'
import { subagentTools } from './tools/subagent'
import {
  appendMessage,
  cancelPendingUserMessage,
  claimNextPendingUserMessage,
  claimPendingUserMessage,
  claimGoalPhase,
  completePendingUserMessage,
  commitGoalEvaluation,
  commitGoalExecution,
  downgradePendingSteer,
  enqueuePendingUserMessage,
  getSession,
  listPendingUserMessages,
  pauseGoal,
  restorePendingUserMessageClaim,
  startSessionRunActivity,
  finishSessionRunActivity,
  steerPendingUserMessage
} from './store/sessions'
import { resolveProjectPath } from './store/projects'
import { getMcpTools } from './tools/mcp-bridge'
import { webTools } from './tools/web'
import { imageTools } from './tools/image'
import { gitTools } from './tools/git'
import { buildCapabilitySnapshot } from './agent/capabilities'
import { buildGeneratedToolDefinitions, listGeneratedToolSnapshotBindings, type GeneratedToolSnapshotBinding } from './generated-tools/adapter'
import { researchReportTools } from './tools/research-report'
import { contextTools } from './tools/context-retrieve'
import { createResearchContext } from './research/context'
import type { ChatIntent, ChatMessage, ReasoningLevel, RunMode, StreamEvent } from '@shared/types'
import type { ToolSet } from 'ai'
import { StreamTransport } from './stream-transport'
import { projectSessionModelMessages } from './session-context'
import { buildPlanTools, normalizeChatIntent } from './plan'
import { GoalCoordinator } from './goal/coordinator'
import { evaluateGoal } from './goal/evaluator'
import { matchImageGenerationRequest, runDirectImageGeneration } from './image-generation'
import { resolveExecutionContract } from './agent/execution-contract'
import { getDefaultContinuationScheduler } from './generated-tools/continuation-scheduler-runtime'
import type { ToolForgeContinuationV2 } from '../shared/generated-tools'
import {
  EndpointGenerationRegistry,
  RunRegistry,
  type ActiveRunSummary,
  type RunActivityListener,
  type RunPhase,
  type RunTerminalReason
} from './run-registry'

const REASONING_LEVELS = ['auto', 'none', 'low', 'medium', 'high'] as const
const SKILL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
const MAX_REQUEST_SKILLS = 16

function normalizeSkillIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('Invalid Skill selection')
  if (value.some((item) => typeof item !== 'string' || !SKILL_ID_PATTERN.test(item))) throw new Error('Invalid Skill selection')
  return [...new Set(value as string[])].slice(0, MAX_REQUEST_SKILLS)
}

function normalizeReasoningLevel(value: unknown): ReasoningLevel {
  return typeof value === 'string' && (REASONING_LEVELS as readonly string[]).includes(value) ? (value as ReasoningLevel) : 'auto'
}

function normalizeRunMode(value: unknown): RunMode {
  return value === 'research' ? 'research' : 'chat'
}

function buildAllTools(
  workspacePath: string | null,
  allowedMcpTools?: readonly string[],
  generatedToolVersions: GeneratedToolSnapshotBinding[] = [],
  projectId?: string
): ToolDefinition[] {
  const base = [...contextTools, ...fsTools, ...bashTools, ...searchTools, ...todoTools, ...subagentTools, ...webTools, ...imageTools, ...gitTools, ...getMcpTools(allowedMcpTools)]
  const existing = [...base, ...buildToolForgeMetaTools({ builtinTools: base })]
  return [
    ...existing,
    ...buildGeneratedToolDefinitions(
      workspacePath,
      undefined,
      generatedToolVersions,
      new Set(existing.map((tool) => tool.name)),
      projectId
    )
  ]
}

function buildResearchTools(): ToolDefinition[] {
  return [...contextTools, ...todoTools, ...webTools, ...researchReportTools]
}

interface RunRequestOptions {
  reasoningLevel: ReasoningLevel
  runMode: RunMode
  intent?: ChatIntent
  skillIds?: string[]
  projectId?: string
}

interface ActiveRun {
  controller: AbortController
  sessionId: string
  runId: string
  kind: 'chat' | 'goal'
  port: Electron.MessagePortMain
  transport: StreamTransport
  goalCoordinator: GoalCoordinator
  request?: RunRequestOptions
  continuation?: ToolForgeContinuationV2
  claimedPendingMessageId?: string
  stepCommitted?: boolean
  terminalReason?: RunTerminalReason
  activityFinished?: boolean
  allowQueueDrain?: boolean
}

interface StreamEndpoint {
  generation: number
  port: Electron.MessagePortMain
  transport: StreamTransport
  goalCoordinator: GoalCoordinator
  retired: boolean
}

const runRegistry = new RunRegistry<ActiveRun>()
const endpointRegistry = new EndpointGenerationRegistry<StreamEndpoint>()

export function listActiveRuns(windowId?: number): ActiveRunSummary[] {
  return runRegistry.list(windowId)
}

export function isSessionRunning(sessionId: string): boolean {
  return runRegistry.isSessionRunning(sessionId)
}

export function subscribeRunActivity(listener: RunActivityListener): () => void {
  return runRegistry.subscribe(listener)
}

function activeRun(runId: string | undefined): ActiveRun | undefined {
  return runId ? runRegistry.get(runId)?.value : undefined
}

function activeSessionRun(sessionId: string): ActiveRun | undefined {
  return runRegistry.getForSession(sessionId)?.value
}

function activeWindowRuns(windowId: number): ActiveRun[] {
  return runRegistry.list(windowId).flatMap((summary) => {
    const run = activeRun(summary.runId)
    return run ? [run] : []
  })
}

function ownsRun(run: Pick<ActiveRun, 'runId'>): boolean {
  return activeRun(run.runId) === run
}

function startRunActivity(run: ActiveRun): boolean {
  const registration = runRegistry.get(run.runId)
  return Boolean(registration && startSessionRunActivity(run.sessionId, run.runId, run.kind, registration.startedAt))
}

function finishRunActivity(run: ActiveRun, state: 'completed' | 'failed' | 'cancelled' | 'interrupted', error?: string): void {
  if (run.activityFinished) return
  const finished = finishSessionRunActivity(run.sessionId, run.runId, state, error)
  if (finished) run.activityFinished = true
}

function releaseRun(run: ActiveRun, reason: RunTerminalReason = run.terminalReason ?? (run.controller.signal.aborted ? 'aborted' : 'completed')): boolean {
  if (!ownsRun(run)) return false
  const terminalReason = run.activityFinished ? reason : 'error'
  const released = runRegistry.release(run.runId, terminalReason)
  if (released) {
    // Promotion may create a ready continuation while the source run still owns
    // the session. Reconcile after releasing that owner so the continuation can
    // claim the session without requiring a second user message or app restart.
    void getDefaultContinuationScheduler()?.dispatchReady().catch((error) => {
      console.error('Continuation dispatch after run release failed', error)
    })
  }
  return Boolean(released)
}

function phaseForEvent(run: ActiveRun, event: StreamEvent): RunPhase | undefined {
  switch (event.type) {
    case 'message-start':
      return 'running'
    case 'token':
    case 'context-usage':
      return 'streaming'
    case 'step-start':
      return run.kind === 'goal' ? 'goal-execution' : 'running'
    case 'tool-call':
    case 'tool-result':
    case 'tool-error':
      return 'tool'
    case 'goal-update':
      return event.goal?.status === 'validating' ? 'goal-validation' : event.goal?.status === 'executing' ? 'goal-execution' : 'running'
    case 'error':
      run.terminalReason = 'error'
      return 'error'
    case 'abort':
      run.terminalReason = 'aborted'
      return 'aborting'
    default:
      return undefined
  }
}

function observeRunEvent(run: ActiveRun, event: StreamEvent): void {
  const phase = phaseForEvent(run, event)
  if (phase) runRegistry.updatePhase(run.runId, phase)
}

function createWindowGoalCoordinator(win: BrowserWindow): GoalCoordinator {
  return new GoalCoordinator({
    getGoal: (sessionId) => getSession(sessionId)?.goal,
    getMessage: (sessionId, messageId) => getSession(sessionId)?.messages.find((message) => message.id === messageId),
    claimPhase: claimGoalPhase,
    commitExecution: commitGoalExecution,
    commitEvaluation: commitGoalEvaluation,
    pause: pauseGoal,
    evaluate: evaluateGoal,
    execute: async ({ sessionId, invocationId, goal, signal, onEvent }) => {
      const session = getSession(sessionId)
      if (!session) throw new Error('Invalid session')
      const requestedProjectId = goal.executionContext.projectId
      const projectId = session.projectId
      if (requestedProjectId !== projectId) throw new Error('Goal project does not match the session project')
      const workspacePath = projectId ? resolveProjectPath(projectId) : null
      if (projectId && !workspacePath) throw new Error('Invalid or unavailable Goal project')
      const generatedToolVersions = workspacePath
        ? listGeneratedToolSnapshotBindings({ projectId })
        : []
      const capabilities = buildCapabilitySnapshot(
        goal.executionContext.skillIds,
        workspacePath,
        'chat',
        {
          goalObjective: goal.objective,
          goalFeedback: goal.feedback,
          goalRound: goal.currentRound,
          generatedToolVersions
        }
      )
      const toolContext: ToolContext = {
        workspacePath,
        sessionId,
        runId: invocationId,
        approvalGate: createApprovalGate(win, sessionId, invocationId, 'chat'),
        abortSignal: signal,
        onToolCall: (info) => { void info },
        onSubagentActivity: (activity) => onEvent({ type: 'subagent-update', sessionId, runId: invocationId, activity })
      }
      const projection = projectSessionModelMessages(session.messages, session.contextCheckpoint)
      const goalMessages = projection.messages.length > 0
        ? projection.messages
        : [{ role: 'user' as const, content: `Execute the active Goal objective for round ${goal.currentRound}.` }]
      const definitions = buildAllTools(
        workspacePath,
        capabilities.allowedMcpTools,
        capabilities.generatedToolVersions,
        projectId
      )
      const tools: ToolSet = buildToolSet(definitions, toolContext)
      try {
        return await runAgent({
          sessionId,
          runId: invocationId,
          messages: goalMessages,
          tools,
          reasoningLevel: goal.executionContext.reasoningLevel,
          runMode: 'chat',
          capabilities,
          checkpointUsed: projection.checkpointUsed,
          onEvent: (event) => event.type === 'done' ? undefined : onEvent(event),
          signal
        })
      } finally {
        cancelApprovalsForRun({ windowId: win.id, sessionId, runId: invocationId })
      }
    }
  })
}

function isCurrentEndpoint(windowId: number, generation: number): boolean {
  return endpointRegistry.current(windowId)?.generation === generation
}

export function retireStreaming(windowId: number, reason = 'Renderer stream endpoint retired'): boolean {
  const registered = endpointRegistry.retire(windowId)
  if (!registered) return false
  const endpoint = registered.value
  endpoint.retired = true
  getDefaultContinuationScheduler()?.detach(windowId)
  for (const active of activeWindowRuns(windowId)) {
    active.allowQueueDrain = false
    active.goalCoordinator.stop(active.sessionId)
  }
  abort(windowId, undefined, { drain: false })
  cleanupApprovalWindow(windowId)
  endpoint.transport.close(reason)
  try { endpoint.port.close() } catch { /* The renderer may already have destroyed the port. */ }
  return true
}

function failRegisteredRunStartup(run: ActiveRun, error: unknown): void {
  if (!ownsRun(run)) return
  const message = error instanceof Error ? error.message : 'Failed to start run'
  run.terminalReason = 'error'
  if (run.claimedPendingMessageId) restorePendingUserMessageClaim(run.sessionId, run.claimedPendingMessageId, run.runId)
  finishRunActivity(run, 'failed', message)
  cancelApprovalsForRun({ windowId: runRegistry.get(run.runId)?.windowId ?? -1, sessionId: run.sessionId, runId: run.runId })
  void run.transport.send({ type: 'error', sessionId: run.sessionId, runId: run.runId, error: message }).catch(() => undefined)
  void run.transport.send({ type: 'done', sessionId: run.sessionId, runId: run.runId }).catch(() => undefined)
  releaseRun(run, 'error')
}

/** Each renderer document gets one generation-fenced MessagePort endpoint. */
export function setupStreaming(win: BrowserWindow): void {
  retireStreaming(win.id, 'Renderer stream endpoint replaced')
  const { port1, port2 } = new MessageChannelMain()
  const goalCoordinator = createWindowGoalCoordinator(win)
  const transport = new StreamTransport({
    postMessage: (message) => port2.postMessage(message),
    onFlow: (flow) => port2.postMessage({ type: 'stream:flow', flow })
  })
  const endpoint: StreamEndpoint = { generation: 0, port: port2, transport, goalCoordinator, retired: false }
  endpoint.generation = endpointRegistry.activate(win.id, endpoint).generation
  win.webContents.postMessage('stream:port', { generation: endpoint.generation }, [port1])
  getDefaultContinuationScheduler()?.attach(win.id, {
    isSessionRunning,
    dispatch: async (continuation) => {
      if (continuation.status !== 'dispatched' || !continuation.continuationRunId) return
      const binding = listGeneratedToolSnapshotBindings({ projectId: continuation.request.projectId }).find((item) => item.toolId === continuation.toolId && item.versionId === continuation.versionId && item.fingerprint === continuation.fingerprint && item.capabilityRevision === continuation.toCapabilityRevision)
      if (!binding) {
        const scheduler = getDefaultContinuationScheduler()
        const current = scheduler?.read(continuation.id)
        if (scheduler && current && current.status === 'dispatched') scheduler.fail(continuation.id, current.revision, 'Promoted Generated Tool binding is no longer active')
        return
      }
      const scheduler = getDefaultContinuationScheduler()
      const current = scheduler?.read(continuation.id)
      if (!scheduler || !current || current.status !== 'dispatched' || current.continuationRunId !== continuation.continuationRunId) return
      const running = scheduler.markRunning(current.id, current.revision)
      handleSend(win, port2, transport, continuation.continuationRunId, continuation.sessionId, normalizeReasoningLevel(continuation.request.reasoningLevel), continuation.request.runMode, undefined, continuation.request.skillIds, continuation.request.projectId, undefined, { ...continuation, ...running })
    }
  })

  const onClosed = (): void => {
    retireStreaming(win.id, 'BrowserWindow closed')
    win.removeListener('closed', onClosed)
  }
  win.on('closed', onClosed)

  port2.on('message', (event: Electron.MessageEvent) => {
    if (!isCurrentEndpoint(win.id, endpoint.generation)) return
    const data = event.data
    if (!data || typeof data !== 'object') return
    if (data.type === 'stream:ready') {
      transport.ready(typeof data.credit === 'number' ? data.credit : undefined)
      return
    }
    if (data.type === 'stream:ack') {
      if (typeof data.seq === 'number' && typeof data.runId === 'string') transport.ack(data.seq, data.runId)
      return
    }
    if (data.type === 'chat:send') {
      const sessionId = typeof data.sessionId === 'string' ? data.sessionId : ''
      const runId = typeof data.runId === 'string' ? data.runId : crypto.randomUUID()
      if (!sessionId || !getSession(sessionId)) {
        void transport.send({ type: 'error', sessionId, runId, error: 'Invalid session' })
        void transport.send({ type: 'done', sessionId, runId })
        return
      }
      try {
        handleSend(win, port2, transport, runId, sessionId, normalizeReasoningLevel(data.reasoningLevel), normalizeRunMode(data.runMode), normalizeChatIntent(data.intent), normalizeSkillIds(data.skillIds), typeof data.projectId === 'string' ? data.projectId : undefined)
      } catch (error) {
        void transport.send({ type: 'error', sessionId, runId, error: error instanceof Error ? error.message : 'Invalid message' })
        void transport.send({ type: 'done', sessionId, runId })
      }
    } else if (data.type === 'chat:enqueue') {
      const sessionId = typeof data.sessionId === 'string' ? data.sessionId : ''
      const active = activeSessionRun(sessionId)
      const runId = active?.runId ?? (typeof data.expectedRunId === 'string' ? data.expectedRunId : crypto.randomUUID())
      const message = normalizePendingMessage(data.message)
      const mode = data.mode === 'steer' ? 'steer' : 'queue'
      if (!sessionId || !message) {
        void transport.send({ type: 'message-deferred', sessionId, runId, pendingMessageId: message?.id ?? '', reason: 'invalid-input' })
        return
      }
      const canSteer = mode === 'steer' && active?.kind === 'chat' && active.sessionId === sessionId && active.runId === data.expectedRunId && !active.controller.signal.aborted
      const result = enqueuePendingUserMessage(sessionId, {
        mode: canSteer ? 'steer' : 'queue',
        message,
        ...(canSteer ? { targetRunId: active.runId } : {})
      })
      if (!result.success || !result.pendingMessage) {
        void transport.send({ type: 'message-deferred', sessionId, runId, pendingMessageId: message.id, reason: result.error ?? 'enqueue-failed' })
        return
      }
      void transport.send({ type: 'message-queued', sessionId, runId, pending: result.pendingMessage })
      emitQueueUpdated(transport, sessionId, runId)
      if (!active && result.pendingMessage.mode === 'queue') {
        void drainNextPending(win, endpoint, sessionId, normalizeRunRequest(data.request))
      }
    } else if (data.type === 'chat:steer-pending') {
      const sessionId = typeof data.sessionId === 'string' ? data.sessionId : ''
      const pendingMessageId = typeof data.pendingMessageId === 'string' ? data.pendingMessageId : ''
      const expectedRunId = typeof data.expectedRunId === 'string' ? data.expectedRunId : ''
      const active = activeSessionRun(sessionId)
      const canSteer = Boolean(sessionId && pendingMessageId && expectedRunId && active?.kind === 'chat' && active.sessionId === sessionId && active.runId === expectedRunId && !active.controller.signal.aborted)
      if (!canSteer) {
        void transport.send({ type: 'message-deferred', sessionId, runId: active?.runId ?? expectedRunId, pendingMessageId, reason: 'run-unavailable' })
        return
      }
      const result = steerPendingUserMessage(sessionId, pendingMessageId, expectedRunId)
      if (!result.success) {
        void transport.send({ type: 'message-deferred', sessionId, runId: expectedRunId, pendingMessageId, reason: result.error ?? 'steer-failed' })
        return
      }
      emitQueueUpdated(transport, sessionId, expectedRunId)
    } else if (data.type === 'chat:cancel-pending') {
      const sessionId = typeof data.sessionId === 'string' ? data.sessionId : ''
      const pendingMessageId = typeof data.pendingMessageId === 'string' ? data.pendingMessageId : ''
      const active = activeSessionRun(sessionId)
      const result = cancelPendingUserMessage(sessionId, pendingMessageId)
      if (!result.success) {
        void transport.send({ type: 'message-deferred', sessionId, runId: active?.runId, pendingMessageId, reason: result.error ?? 'cancel-failed' })
      }
      emitQueueUpdated(transport, sessionId, active?.runId)
    } else if (data.type === 'goal:start') {
      const sessionId = typeof data.sessionId === 'string' ? data.sessionId : ''
      const runId = typeof data.runId === 'string' ? data.runId : crypto.randomUUID()
      if (!sessionId || !getSession(sessionId)) {
        void transport.send({ type: 'error', sessionId, runId, error: 'Invalid session' })
        void transport.send({ type: 'done', sessionId, runId })
        return
      }
      const controller = new AbortController()
      const active: ActiveRun = { controller, sessionId, runId, kind: 'goal', port: port2, transport, goalCoordinator, allowQueueDrain: true }
      if (!runRegistry.register({ windowId: win.id, sessionId, runId, kind: 'goal' }, active)) {
        void transport.send({ type: 'error', sessionId, runId, error: 'Session is already running' })
        void transport.send({ type: 'done', sessionId, runId })
        return
      }
      if (!startRunActivity(active)) {
        failRegisteredRunStartup(active, new Error('Failed to record run activity'))
        return
      }
      try {
        const onEvent = (streamEvent: StreamEvent): Promise<void> => {
        if (!ownsRun(active)) return Promise.resolve()
        observeRunEvent(active, streamEvent)
        return transport.send({ ...streamEvent, runId }, controller.signal)
      }
      void goalCoordinator.run({ sessionId, signal: controller.signal, onEvent })
        .then(async (result) => {
          if (!ownsRun(active)) return
          if (result.status === 'completed') {
            finishRunActivity(active, 'completed')
          } else if (result.status === 'paused' && controller.signal.aborted) {
            finishRunActivity(active, 'cancelled')
            active.terminalReason = 'aborted'
          } else if (result.status === 'interrupted' || result.status === 'superseded') {
            finishRunActivity(active, 'interrupted')
          } else {
            active.terminalReason = 'error'
            const error = result.status === 'not-started'
              ? `Goal did not start: ${result.error ?? 'invalid-transition'}`
              : `Goal ended with status: ${result.status}`
            finishRunActivity(active, 'failed', error)
            if (result.status === 'not-started') await onEvent({ type: 'error', sessionId, runId, error })
          }
        })
        .catch(async (error) => {
          active.terminalReason = 'error'
          const message = error instanceof Error ? error.message : 'Goal run failed'
          finishRunActivity(active, controller.signal.aborted ? 'cancelled' : 'failed', controller.signal.aborted ? undefined : message)
          await onEvent({ type: 'error', sessionId, runId, error: message }).catch(() => undefined)
        })
        .finally(async () => {
          if (!ownsRun(active)) return
          if (!active.activityFinished) finishRunActivity(active, controller.signal.aborted ? 'cancelled' : 'failed', controller.signal.aborted ? undefined : 'Goal run ended without a terminal result')
          await onEvent({ type: 'done', sessionId, runId }).catch(() => undefined)
          releaseRun(active)
          if (active.allowQueueDrain !== false && isCurrentEndpoint(win.id, endpoint.generation)) {
            await drainNextPending(win, endpoint, sessionId)
          }
        })
      } catch (error) {
        failRegisteredRunStartup(active, error)
      }
    } else if (data.type === 'chat:abort') {
      const runId = typeof data.runId === 'string' ? data.runId : undefined
      const active = activeRun(runId)
      if (active && runRegistry.get(active.runId)?.windowId === win.id) active.goalCoordinator.stop(active.sessionId)
      abort(win.id, runId, { drain: true })
    }
  })
  port2.start()
}

function handleSend(
  win: BrowserWindow,
  port: Electron.MessagePortMain,
  transport: StreamTransport,
  runId: string,
  sessionId: string,
  reasoningLevel: ReasoningLevel,
  runMode: RunMode,
  intent?: ChatIntent,
  skillIds?: string[],
  projectId?: string,
  claimedPendingMessageId?: string,
  continuation?: ToolForgeContinuationV2
): void {
  const existingSessionRun = activeSessionRun(sessionId)
  if (existingSessionRun) {
    void transport.send({ type: 'error', sessionId, runId, error: 'Session is already running' })
    void transport.send({ type: 'done', sessionId, runId })
    return
  }
  const controller = new AbortController()
  const request: RunRequestOptions = { reasoningLevel, runMode, intent, skillIds, projectId }
  const activeRun: ActiveRun = { controller, sessionId, runId, kind: 'chat', port, transport, goalCoordinator: createWindowGoalCoordinator(win), request, continuation, claimedPendingMessageId, stepCommitted: false, allowQueueDrain: true }
  if (!runRegistry.register({ windowId: win.id, sessionId, runId, kind: 'chat' }, activeRun)) {
    if (claimedPendingMessageId) restorePendingUserMessageClaim(sessionId, claimedPendingMessageId, runId)
    void transport.send({ type: 'error', sessionId, runId, error: 'Session is already running' })
    void transport.send({ type: 'done', sessionId, runId })
    return
  }
  try {
    if (!startRunActivity(activeRun)) {
      failRegisteredRunStartup(activeRun, new Error('Failed to record run activity'))
      return
    }
  let terminalDone = false
  const onEvent = (event: StreamEvent): Promise<void> => {
    if (!ownsRun(activeRun)) return Promise.resolve()
    observeRunEvent(activeRun, event)
    if (event.type === 'done') {
      terminalDone = true
      return Promise.resolve()
    }
    if (event.type === 'message-end') return Promise.resolve()
    return transport.send({ ...event, runId }, controller.signal)
  }

  const session = getSession(sessionId)
  if (!session) {
    const error = 'Invalid session'
    onEvent({ type: 'error', sessionId, runId, error }).catch(() => undefined)
    onEvent({ type: 'done', sessionId, runId }).catch(() => undefined)
    finishRunActivity(activeRun, 'failed', error)
    if (claimedPendingMessageId) restorePendingUserMessageClaim(sessionId, claimedPendingMessageId, runId)
    releaseRun(activeRun, 'error')
    return
  }
  const requestedProjectId = projectId
  const persistedProjectId = session.projectId
  if (requestedProjectId !== undefined && requestedProjectId !== persistedProjectId) {
    const error = 'Requested project does not match the session project'
    onEvent({ type: 'error', sessionId, runId, error }).catch(() => undefined)
    onEvent({ type: 'done', sessionId, runId }).catch(() => undefined)
    finishRunActivity(activeRun, 'failed', error)
    if (claimedPendingMessageId) restorePendingUserMessageClaim(sessionId, claimedPendingMessageId, runId)
    releaseRun(activeRun, 'error')
    return
  }
  projectId = persistedProjectId
  activeRun.request = { ...request, projectId }
  const workspacePath = projectId ? resolveProjectPath(projectId) : null
  if (projectId && !workspacePath) {
    const error = 'Invalid or unavailable project'
    onEvent({ type: 'error', sessionId, runId, error }).catch(() => undefined)
    onEvent({ type: 'done', sessionId, runId }).catch(() => undefined)
    finishRunActivity(activeRun, 'failed', error)
    if (claimedPendingMessageId) restorePendingUserMessageClaim(sessionId, claimedPendingMessageId, runId)
    releaseRun(activeRun, 'error')
    return
  }

  if (intent === 'plan' && runMode !== 'chat') {
    const error = 'Plan intent requires chat mode'
    onEvent({ type: 'error', sessionId, runId, error }).catch(() => undefined)
    onEvent({ type: 'done', sessionId, runId }).catch(() => undefined)
    finishRunActivity(activeRun, 'failed', error)
    if (claimedPendingMessageId) restorePendingUserMessageClaim(sessionId, claimedPendingMessageId, runId)
    releaseRun(activeRun, 'error')
    return
  }

  const researchContext = runMode === 'research' ? createResearchContext() : undefined
  const toolContext: ToolContext = {
    workspacePath,
    sessionId,
    runId,
    approvalGate: createApprovalGate(win, sessionId, runId, runMode),
    researchContext,
    abortSignal: controller.signal,
    onToolCall: (info) => { void info },
    onSubagentActivity: (activity) => onEvent({ type: 'subagent-update', sessionId, runId, activity })
  }
  const latestUser = [...session.messages].reverse().find((message) => message.role === 'user')
  const directImageRequest = runMode === 'chat' && intent === undefined && latestUser
    ? matchImageGenerationRequest(latestUser.content)
    : null
  if (directImageRequest) {
    void runDirectImageGeneration({
      sessionId,
      runId,
      prompt: directImageRequest.prompt,
      context: toolContext,
      onEvent
    })
      .then(async (result) => {
        if (!ownsRun(activeRun)) return
        if (result.status === 'aborted') {
          activeRun.terminalReason = 'aborted'
          finishRunActivity(activeRun, 'cancelled')
        } else {
          if (!appendMessage(sessionId, result.message)) throw new Error('Failed to persist generated image message')
          await transport.send({ type: 'message-end', sessionId, runId, messageId: result.message.id }).catch(() => undefined)
          if (result.status === 'error') {
            activeRun.terminalReason = 'error'
          }
        }
        if (claimedPendingMessageId) completePendingUserMessage(sessionId, claimedPendingMessageId, runId)
        const steers = listPendingUserMessages(sessionId).pending.filter((item) => item.mode === 'steer' && item.targetRunId === runId)
        for (const steer of steers) {
          downgradePendingSteer(sessionId, steer.message.id)
          await onEvent({ type: 'message-deferred', sessionId, runId, pendingMessageId: steer.message.id, reason: 'no-next-step' })
        }
        await emitQueueUpdated(transport, sessionId, runId)
        if (result.status === 'error') {
          finishRunActivity(activeRun, 'failed', result.message.toolCalls?.[0]?.output ?? 'Image generation failed')
        } else if (result.status === 'completed') {
          finishRunActivity(activeRun, 'completed')
        }
      })
      .catch(async (error) => {
        console.error('Direct image run failed outside its lifecycle guard', error)
        activeRun.terminalReason = controller.signal.aborted ? 'aborted' : 'error'
        const message = error instanceof Error ? error.message : 'Image generation failed'
        if (claimedPendingMessageId) restorePendingUserMessageClaim(sessionId, claimedPendingMessageId, runId)
        finishRunActivity(activeRun, controller.signal.aborted ? 'cancelled' : 'failed', controller.signal.aborted ? undefined : message)
        await onEvent({ type: 'error', sessionId, runId, error: message }).catch(() => undefined)
      })
      .finally(async () => {
        if (!ownsRun(activeRun)) return
        if (!activeRun.activityFinished) finishRunActivity(activeRun, controller.signal.aborted ? 'cancelled' : 'failed', controller.signal.aborted ? undefined : 'Image generation ended without a terminal result')
        cancelApprovalsForRun({ windowId: win.id, sessionId, runId })
        await transport.send({ type: 'done', sessionId, runId }).catch(() => undefined)
        releaseRun(activeRun)
        const endpoint = endpointRegistry.current(win.id)?.value
        if (activeRun.allowQueueDrain !== false && endpoint && endpoint.port === port && endpoint.transport === transport) {
          await drainNextPending(win, endpoint, sessionId, request)
        }
      })
    return
  }
  const generatedToolVersions = runMode === 'chat' && intent !== 'plan' && workspacePath
    ? listGeneratedToolSnapshotBindings({ projectId })
    : []
  const capabilities = buildCapabilitySnapshot(skillIds, workspacePath, runMode, {
    intent,
    generatedToolVersions
  })
  const projection = projectSessionModelMessages(session.messages, session.contextCheckpoint)
  const definitions = runMode === 'research'
    ? buildResearchTools()
    : intent === 'plan'
      ? buildPlanTools()
      : buildAllTools(
          workspacePath,
          capabilities.allowedMcpTools,
          capabilities.generatedToolVersions,
          projectId
        )
  const tools: ToolSet = buildToolSet(definitions, toolContext)
  const binding = activeRun.continuation
    ? capabilities.generatedToolVersions.find((item) => item.toolId === activeRun.continuation?.toolId && item.versionId === activeRun.continuation?.versionId)
    : undefined
  const executionContract = activeRun.continuation
    ? {
        taskKind: 'tool-forge-continuation' as const,
        requireToolCall: true as const,
        activeToolNames: definitions.map((definition) => definition.name),
        requiredFirstTool: {
          toolName: activeRun.continuation.toolId,
          toolId: activeRun.continuation.toolId,
          versionId: activeRun.continuation.versionId,
          fingerprint: activeRun.continuation.fingerprint,
          validationReportId: activeRun.continuation.validationReportId,
          pointerRevision: binding?.pointerRevision,
          capabilityRevision: activeRun.continuation.toCapabilityRevision
        },
        reason: 'Promoted Generated Tool continuation requires the exact promoted tool as its first call'
      }
    : resolveExecutionContract({
    userText: latestUser?.content ?? '',
    runMode,
    intent,
    workspacePath,
    availableToolNames: definitions.map((definition) => definition.name)
  })
  void runAgent({
    sessionId,
    runId,
    messages: projection.messages,
    tools,
    reasoningLevel,
    runMode,
    capabilities,
    executionContract: executionContract ?? undefined,
    checkpointUsed: projection.checkpointUsed,
    takeSteerMessages: async (stepNumber) => {
      if (!ownsRun(activeRun) || activeRun.controller.signal.aborted) return []
      const pending = listPendingUserMessages(sessionId).pending
        .filter((item) => item.mode === 'steer' && item.targetRunId === runId)
        .sort((left, right) => left.sequence - right.sequence)
      const applied: ChatMessage[] = []
      for (const item of pending) {
        const claimed = claimPendingUserMessage(sessionId, item.message.id, runId)
        if (!claimed.success || !claimed.pendingMessage) continue
        applied.push(claimed.pendingMessage.message)
        await onEvent({ type: 'message-applied', sessionId, runId, pendingMessageId: item.message.id, disposition: 'steer', stepNumber })
      }
      if (applied.length > 0) emitQueueUpdated(transport, sessionId, runId)
      return applied
    },
    onStepCommitted: async (message) => {
      if (!ownsRun(activeRun)) return
      if (!appendMessage(sessionId, message)) throw new Error('Failed to persist assistant step')
      activeRun.stepCommitted = true
      for (const pending of getSession(sessionId)?.pendingUserMessages ?? []) {
        if (pending.status === 'claimed' && pending.claimedByRunId === runId && pending.mode === 'steer') {
          completePendingUserMessage(sessionId, pending.message.id, runId)
        }
      }
    },
    onEvent,
    signal: controller.signal
  })
    .then(async (result) => {
      if (!ownsRun(activeRun)) return
      if (result.status === 'completed' || result.status === 'step-limit' || result.status === 'repetition') {
        if (!activeRun.stepCommitted && (result.segments.length > 0 || result.text)) {
          const assistantMessage = assistantMessageFromResult(result, runMode)
          if (!appendMessage(sessionId, assistantMessage)) throw new Error('Failed to persist assistant message')
        }
      }
      if (claimedPendingMessageId) completePendingUserMessage(sessionId, claimedPendingMessageId, runId)
      const steers = listPendingUserMessages(sessionId).pending.filter((item) => item.mode === 'steer' && item.targetRunId === runId)
      for (const steer of steers) {
        downgradePendingSteer(sessionId, steer.message.id)
        await onEvent({ type: 'message-deferred', sessionId, runId, pendingMessageId: steer.message.id, reason: 'no-next-step' })
      }
      await emitQueueUpdated(transport, sessionId, runId)
      if (terminalDone && (result.status === 'completed' || result.status === 'step-limit' || result.status === 'repetition')) {
        await transport.send({ type: 'message-end', sessionId, runId, messageId: result.messageId, usage: result.usage }).catch(() => undefined)
      }
      if (result.status === 'completed' || result.status === 'step-limit') {
        finishRunActivity(activeRun, 'completed')
        if (activeRun.continuation) {
          const scheduler = getDefaultContinuationScheduler()
          const current = scheduler?.read(activeRun.continuation.id)
          if (scheduler && current && current.status === 'running' && current.continuationRunId === runId) scheduler.complete(current.id, current.revision)
        }
      } else if (result.status === 'repetition') {
        activeRun.terminalReason = 'error'
        finishRunActivity(activeRun, 'failed', result.error)
      } else if (result.status === 'aborted') {
        activeRun.terminalReason = 'aborted'
        finishRunActivity(activeRun, 'cancelled')
        if (activeRun.continuation) {
          const scheduler = getDefaultContinuationScheduler()
          const current = scheduler?.read(activeRun.continuation.id)
          if (scheduler && current && ['dispatched', 'running'].includes(current.status) && current.continuationRunId === runId) scheduler.cancel(current.id, current.revision, 'continuation-run-aborted')
        }
      } else {
        activeRun.terminalReason = 'error'
        finishRunActivity(activeRun, 'failed', result.error)
        if (activeRun.continuation) {
          const scheduler = getDefaultContinuationScheduler()
          const current = scheduler?.read(activeRun.continuation.id)
          if (scheduler && current && ['dispatched', 'running'].includes(current.status) && current.continuationRunId === runId) scheduler.fail(current.id, current.revision, result.error)
        }
      }
    })
    .catch(async (error) => {
      console.error('Agent run failed outside its lifecycle guard', error)
      activeRun.terminalReason = controller.signal.aborted ? 'aborted' : 'error'
      const message = error instanceof Error ? error.message : 'Agent run failed'
      if (claimedPendingMessageId) restorePendingUserMessageClaim(sessionId, claimedPendingMessageId, runId)
      if (activeRun.continuation) {
        const scheduler = getDefaultContinuationScheduler()
        const current = scheduler?.read(activeRun.continuation.id)
        if (scheduler && current && ['dispatched', 'running'].includes(current.status) && current.continuationRunId === runId) {
          if (controller.signal.aborted) scheduler.cancel(current.id, current.revision, 'continuation-run-aborted')
          else scheduler.fail(current.id, current.revision, message)
        }
      }
      finishRunActivity(activeRun, controller.signal.aborted ? 'cancelled' : 'failed', controller.signal.aborted ? undefined : message)
      await onEvent({ type: 'error', sessionId, runId, error: message }).catch(() => undefined)
    })
    .finally(async () => {
      if (!ownsRun(activeRun)) return
      if (!activeRun.activityFinished) finishRunActivity(activeRun, controller.signal.aborted ? 'cancelled' : 'failed', controller.signal.aborted ? undefined : 'Agent run ended without a terminal result')
      cancelApprovalsForRun({ windowId: win.id, sessionId, runId })
      await transport.send({ type: 'done', sessionId, runId }).catch(() => undefined)
      releaseRun(activeRun)
      const endpoint = endpointRegistry.current(win.id)?.value
      if (activeRun.allowQueueDrain !== false && endpoint && endpoint.port === port && endpoint.transport === transport) {
        await drainNextPending(win, endpoint, sessionId, request)
      }
    })
  } catch (error) {
    failRegisteredRunStartup(activeRun, error)
  }
}

function normalizePendingMessage(value: unknown): ChatMessage | null {
  if (!value || typeof value !== 'object') return null
  const message = value as Partial<ChatMessage>
  if (typeof message.id !== 'string' || !message.id || message.role !== 'user' || typeof message.content !== 'string' || typeof message.createdAt !== 'number') return null
  if (message.runMode !== undefined && message.runMode !== 'chat' && message.runMode !== 'research') return null
  return message as ChatMessage
}

function normalizeRunRequest(value: unknown, fallback: RunRequestOptions = { reasoningLevel: 'auto', runMode: 'chat' }): RunRequestOptions {
  if (!value || typeof value !== 'object') return fallback
  const request = value as Record<string, unknown>
  return {
    reasoningLevel: normalizeReasoningLevel(request.reasoningLevel),
    runMode: normalizeRunMode(request.runMode),
    intent: normalizeChatIntent(request.intent),
    skillIds: normalizeSkillIds(request.skillIds),
    projectId: typeof request.projectId === 'string' ? request.projectId : undefined
  }
}

function emitQueueUpdated(transport: StreamTransport, sessionId: string, runId?: string): Promise<void> {
  const result = listPendingUserMessages(sessionId)
  return result.success
    ? transport.send({ type: 'queue-updated', sessionId, runId, pending: result.pending })
    : Promise.resolve()
}

async function drainNextPending(
  win: BrowserWindow,
  endpoint: StreamEndpoint,
  sessionId: string,
  fallbackRequest?: unknown
): Promise<void> {
  if (!isCurrentEndpoint(win.id, endpoint.generation) || isSessionRunning(sessionId)) return
  const runId = crypto.randomUUID()
  const generation = endpoint.generation
  const claimed = claimNextPendingUserMessage(sessionId, runId)
  if (!claimed.success || !claimed.pendingMessage) {
    emitQueueUpdated(endpoint.transport, sessionId)
    return
  }
  if (!isCurrentEndpoint(win.id, generation)) {
    restorePendingUserMessageClaim(sessionId, claimed.pendingMessage.message.id, runId)
    return
  }
  const request = normalizeRunRequest(fallbackRequest, {
    reasoningLevel: 'auto',
    runMode: claimed.pendingMessage.message.runMode ?? 'chat',
    skillIds: claimed.pendingMessage.message.skillIds
  })
  await endpoint.transport.send({
    type: 'message-applied',
    sessionId,
    runId,
    pendingMessageId: claimed.pendingMessage.message.id,
    disposition: 'queue'
  }).catch(() => undefined)
  if (!isCurrentEndpoint(win.id, generation)) {
    restorePendingUserMessageClaim(sessionId, claimed.pendingMessage.message.id, runId)
    return
  }
  emitQueueUpdated(endpoint.transport, sessionId, runId)
  handleSend(win, endpoint.port, endpoint.transport, runId, sessionId, request.reasoningLevel, request.runMode, request.intent, request.skillIds, request.projectId, claimed.pendingMessage.message.id)
}

function assistantMessageFromResult(
  result: Awaited<ReturnType<typeof runAgent>>,
  runMode: RunMode
): ChatMessage {
  return {
    id: result.messageId ?? crypto.randomUUID(),
    role: 'assistant',
    content: result.text,
    toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
    segments: result.segments.length > 0 ? result.segments : undefined,
    usage: result.usage,
    runMode,
    createdAt: Date.now()
  }
}

export function abort(windowId: number, runId?: string, options: { drain?: boolean } = {}): void {
  const targets = runId
    ? runRegistry.list(windowId).filter((run) => run.runId === runId)
    : runRegistry.list(windowId)
  for (const summary of targets) {
    const active = activeRun(summary.runId)
    if (!active) continue
    active.allowQueueDrain = options.drain !== false
    active.terminalReason = 'aborted'
    runRegistry.updatePhase(active.runId, 'aborting')
    active.controller.abort()
    active.transport.cancelRun(active.runId, { drain: options.drain })
    cancelApprovalsForRun({ windowId, sessionId: active.sessionId, runId: active.runId })
  }
}

export function abortGoalSession(sessionId: string): number {
  const active = activeSessionRun(sessionId)
  if (!active || active.kind !== 'goal') return 0
  const registration = runRegistry.get(active.runId)
  if (!registration) return 0
  active.goalCoordinator.stop(sessionId)
  abort(registration.windowId, active.runId)
  return 1
}

export function getActiveRun(windowId: number): Pick<ActiveRun, 'sessionId' | 'runId'> | null {
  const active = listActiveRuns(windowId)[0]
  return active ? { sessionId: active.sessionId, runId: active.runId } : null
}
