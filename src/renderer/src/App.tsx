import { useEffect, useRef, useCallback, useState } from 'react'
import Sidebar from './components/Sidebar'
import ConversationPane from './components/ConversationPane'
import DetailPanel from './components/DetailPanel'
import InputBox, { type InputBoxHandle } from './components/InputBox'
import ApprovalPanel from './components/ApprovalPanel'
import { isSessionRuntimeBusy, useStore } from './store'
import { t, localizeError } from './i18n'
import { acceptsRunEvent, activeRunForSession, adoptQueuedRunOnEvent, clearActiveRun, completeRunOnEvent, requestRunAbort, setActiveRun, type ActiveRendererRuns } from './run-lifecycle'
import { sendUnavailableReason } from './send-readiness'
import type { ChatImagePart, ChatIntent, ChatMessage, StreamEvent, ApprovalRequest, ReasoningLevel, GitStatus, RunMode, GoalCas } from '@shared/types'
import type { GoalCommandMatch } from './slash-commands'
import { selectedSessionGenerationMatches, type SelectedSessionGeneration } from './selected-session-generation'

const TOKEN_BATCH_INTERVAL_MS = 100

export default function App(): React.JSX.Element {
  const portRef = useRef<MessagePort | null>(null)
  const inputBoxRef = useRef<InputBoxHandle>(null)
  const sessionRef = useRef<string | null>(null)
  const sessionLoadRef = useRef(0)
  const selectedSessionGenerationRef = useRef(0)
  const activeRunsRef = useRef<ActiveRendererRuns>({})
  const goalRunIdsRef = useRef<Record<string, string>>({})
  const tokenBufferRef = useRef(new Map<string, { sessionId: string; runId?: string; text: string }>())
  const tokenFrameRef = useRef<number | null>(null)
  const messages = useStore((s) => s.messages)
  const streaming = useStore((s) => s.streaming)
  const contextUsage = useStore((s) => s.contextUsage)
  const reasoningLevel = useStore((s) => s.reasoningLevel)
  const activeRunMode = useStore((s) => s.activeRunMode)
  const pendingUserMessages = useStore((s) => s.pendingUserMessages)
  const approvalQueue = useStore((s) => s.approvalQueue)
  const sessionLoading = useStore((s) => s.sessionLoading)
  const language = useStore((s) => s.language)
  const [modelSwitchNotice, setModelSwitchNotice] = useState<{ provider: string; model: string } | null>(null)
  const [streamPortReady, setStreamPortReady] = useState(false)
  const sendStarting = useStore((s) => s.sendStarting)
  const lastModelRef = useRef<{ provider?: string; model?: string } | null>(null)
  const noticeTimerRef = useRef<number | null>(null)

  const ensureSessionRuntime = useStore((s) => s.ensureSessionRuntime)
  const removeSessionRuntime = useStore((s) => s.removeSessionRuntime)
  const addMessage = useStore((s) => s.addMessage)
  const removeMessage = useStore((s) => s.removeMessage)
  const setMessages = useStore((s) => s.setMessages)
  const startStream = useStore((s) => s.startStream)
  const appendTokenBatch = useStore((s) => s.appendTokenBatch)
  const resetTransientState = useStore((s) => s.resetTransientState)
  const setStreaming = useStore((s) => s.setStreaming)
  const setSendStarting = useStore((s) => s.setSendStarting)
  const setStreamModel = useStore((s) => s.setStreamModel)
  const setContextUsage = useStore((s) => s.setContextUsage)
  const setLatestUsage = useStore((s) => s.setLatestUsage)
  const setReasoningLevel = useStore((s) => s.setReasoningLevel)
  const setActiveRunMode = useStore((s) => s.setActiveRunMode)
  const setStreamRunMode = useStore((s) => s.setStreamRunMode)
  const addPendingToolCall = useStore((s) => s.addPendingToolCall)
  const resolveToolCall = useStore((s) => s.resolveToolCall)
  const failToolCall = useStore((s) => s.failToolCall)
  const failRunningToolCalls = useStore((s) => s.failRunningToolCalls)
  const updateSubagentActivity = useStore((s) => s.updateSubagentActivity)
  const setPendingUserMessages = useStore((s) => s.setPendingUserMessages)
  const dispatchRunActivity = useStore((s) => s.dispatchRunActivity)
  const addApproval = useStore((s) => s.addApproval)
  const setApprovals = useStore((s) => s.setApprovals)
  const removeApproval = useStore((s) => s.removeApproval)
  const setSessions = useStore((s) => s.setSessions)
  const upsertSessionSummary = useStore((s) => s.upsertSessionSummary)
  const removeSessionSummary = useStore((s) => s.removeSessionSummary)
  const setSessionGoal = useStore((s) => s.setSessionGoal)
  const setActiveSession = useStore((s) => s.setActiveSession)
  const setSessionLoading = useStore((s) => s.setSessionLoading)
  const setSessionError = useStore((s) => s.setSessionError)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const setProjects = useStore((s) => s.setProjects)
  const setProjectLoading = useStore((s) => s.setProjectLoading)
  const setProjectError = useStore((s) => s.setProjectError)
  const setActiveProjectId = useStore((s) => s.setActiveProjectId)
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null)
  const [gitStatusLoading, setGitStatusLoading] = useState(false)
  const gitStatusRequestRef = useRef(0)
  const pendingWindowApproval = approvalQueue[0] ?? null

  const beginSelectedSessionGeneration = useCallback((sessionId: string): SelectedSessionGeneration => {
    const token = { sessionId, generation: ++selectedSessionGenerationRef.current }
    sessionRef.current = sessionId
    return token
  }, [])

  const isCurrentSelectedSessionGeneration = useCallback((token: SelectedSessionGeneration): boolean => (
    selectedSessionGenerationMatches(token, sessionRef.current, selectedSessionGenerationRef.current)
  ), [])

  const flushTokenBuffer = useCallback((): void => {
    if (tokenFrameRef.current !== null) {
      window.clearTimeout(tokenFrameRef.current)
      tokenFrameRef.current = null
    }
    if (tokenBufferRef.current.size === 0) return
    const batch = [...tokenBufferRef.current.values()].map(({ sessionId, runId, text }) => ({ sessionId, runId, text }))
    tokenBufferRef.current.clear()
    appendTokenBatch(batch)
  }, [appendTokenBatch])

  const queueToken = useCallback((event: Extract<StreamEvent, { type: 'token' }>): void => {
    const buffered = tokenBufferRef.current.get(event.sessionId)
    tokenBufferRef.current.set(event.sessionId, {
      sessionId: event.sessionId,
      runId: event.runId ?? buffered?.runId,
      text: (buffered?.text ?? '') + event.text
    })
    if (tokenFrameRef.current === null) {
      tokenFrameRef.current = window.setTimeout(flushTokenBuffer, TOKEN_BATCH_INTERVAL_MS)
    }
  }, [flushTokenBuffer])

  const abortSessionRun = useCallback((sessionId: string): void => {
    const activeRun = activeRunForSession(activeRunsRef.current, sessionId)
    if (!activeRun) return
    if (!activeRun.abortRequested && portRef.current) window.joker.chat.abort(portRef.current, activeRun.runId)
    activeRunsRef.current = requestRunAbort(activeRunsRef.current, sessionId)
    dispatchRunActivity(sessionId, { type: 'abort-request' })
  }, [dispatchRunActivity])

  const abortCurrentRun = useCallback((): void => {
    const sessionId = sessionRef.current
    if (sessionId) abortSessionRun(sessionId)
  }, [abortSessionRun])

  const refreshGitStatus = useCallback(async (projectId: string | null): Promise<void> => {
    const requestId = ++gitStatusRequestRef.current
    if (!projectId) {
      setGitStatus(null)
      setGitStatusLoading(false)
      return
    }
    setGitStatusLoading(true)
    const result = await window.joker.project.gitStatus(projectId)
    if (requestId !== gitStatusRequestRef.current) return
    setGitStatus(result.success ? (result.status ?? null) : { isRepository: false, branch: null, detached: false, ahead: 0, behind: 0, changed: 0, untracked: 0, conflicted: 0, clean: false, available: true, error: localizeError(language, result.error ?? t(language, 'project.gitStatusFailed')) })
    setGitStatusLoading(false)
  }, [language])

  const refreshProjects = useCallback(async (): Promise<boolean> => {
    setProjectLoading(true)
    const result = await window.joker.project.get()
    if (!result.success || !result.state) {
      setProjectError(localizeError(language, result.error ?? t(language, 'project.loadFailed')))
      setProjectLoading(false)
      return false
    }
    setProjects(result.state.projects)
    setProjectLoading(false)
    return true
  }, [language, setProjectError, setProjectLoading, setProjects])

  const selectProject = useCallback(async (projectId: string): Promise<boolean> => {
    const sessionId = sessionRef.current
    if (!sessionId || isSessionRuntimeBusy(useStore.getState().sessionRuntimes[sessionId])) return false
    setProjectLoading(true)
    const result = await window.joker.project.select(projectId)
    if (!result.success || !result.state) {
      if (sessionRef.current === sessionId) setProjectError(localizeError(language, result.error ?? t(language, 'project.selectFailed')))
      setProjectLoading(false)
      return false
    }
    setProjects(result.state.projects)
    if (!(await window.joker.session.setProject(sessionId, projectId))) {
      if (sessionRef.current === sessionId) setProjectError(localizeError(language, t(language, 'project.selectFailed')))
      setProjectLoading(false)
      return false
    }
    if (sessionRef.current === sessionId) {
      setActiveProjectId(projectId)
      await refreshGitStatus(projectId)
    }
    setProjectLoading(false)
    return true
  }, [language, refreshGitStatus, setActiveProjectId, setProjectError, setProjectLoading, setProjects])

  const pickProject = useCallback(async (): Promise<boolean> => {
    const sessionId = sessionRef.current
    if (!sessionId || isSessionRuntimeBusy(useStore.getState().sessionRuntimes[sessionId])) return false
    setProjectLoading(true)
    const result = await window.joker.project.pick()
    if (!result.success || !result.state) {
      if (!result.canceled && sessionRef.current === sessionId) setProjectError(localizeError(language, result.error ?? t(language, 'project.selectFailed')))
      setProjectLoading(false)
      return false
    }
    const projectId = result.state.activeProjectId
    if (!projectId || !(await window.joker.session.setProject(sessionId, projectId))) {
      if (sessionRef.current === sessionId) setProjectError(localizeError(language, t(language, 'project.selectFailed')))
      setProjectLoading(false)
      return false
    }
    setProjects(result.state.projects)
    if (sessionRef.current === sessionId) {
      setActiveProjectId(projectId)
      await refreshGitStatus(projectId)
    }
    setProjectLoading(false)
    return true
  }, [language, refreshGitStatus, setActiveProjectId, setProjectError, setProjectLoading, setProjects])

  const clearProject = useCallback(async (): Promise<boolean> => {
    const sessionId = sessionRef.current
    if (!sessionId || isSessionRuntimeBusy(useStore.getState().sessionRuntimes[sessionId])) return false
    if (!(await window.joker.session.setProject(sessionId, null))) return false
    if (sessionRef.current === sessionId) {
      setActiveProjectId(null)
      await refreshGitStatus(null)
    }
    return true
  }, [refreshGitStatus, setActiveProjectId])

  const refreshSessions = useCallback(async (): Promise<void> => {
    const sessions = await window.joker.session.listSummaries()
    setSessions(sessions)
  }, [setSessions])

  const loadSession = useCallback(async (sessionId: string): Promise<void> => {
    const observedSummary = useStore.getState().sessions.find((session) => session.id === sessionId)
    const observedTerminalRevision = observedSummary?.activity.terminalRevision ?? 0
    const selection = beginSelectedSessionGeneration(sessionId)
    const loadId = ++sessionLoadRef.current
    setSessionLoading(true)
    setSessionError(null)
    setMessages([])
    setActiveProjectId(null)
    gitStatusRequestRef.current += 1
    setGitStatus(null)
    setGitStatusLoading(false)
    ensureSessionRuntime(sessionId)
    setActiveSession(sessionId)
    try {
      const session = await window.joker.session.get(sessionId)
      if (loadId !== sessionLoadRef.current || !isCurrentSelectedSessionGeneration(selection)) return
      if (!session) {
        setSessionError(localizeError(language, 'Session not found'))
        return
      }

      setMessages(session.messages)
      let projectId = session.projectId ?? null
      if (projectId && !useStore.getState().projects.some((project) => project.id === projectId)) {
        const projectResult = await window.joker.project.get()
        if (loadId !== sessionLoadRef.current || !isCurrentSelectedSessionGeneration(selection)) return
        if (projectResult.success && projectResult.state) setProjects(projectResult.state.projects)
      }
      if (projectId && !useStore.getState().projects.some((project) => project.id === projectId)) projectId = null
      if (!isCurrentSelectedSessionGeneration(selection)) return
      setActiveProjectId(projectId)
      await refreshGitStatus(projectId)
      if (loadId !== sessionLoadRef.current || !isCurrentSelectedSessionGeneration(selection)) return
      const runtime = useStore.getState().sessionRuntimes[sessionId]
      if (!runtime?.streaming) {
        const lastAssistant = [...session.messages].reverse().find((message) => message.role === 'assistant' && message.usage)
        setLatestUsage(sessionId, lastAssistant?.usage ?? null)
      }
      const pending = await window.joker.session.pending(sessionId).catch(() => null)
      if (loadId !== sessionLoadRef.current || !isCurrentSelectedSessionGeneration(selection)) return
      setPendingUserMessages(sessionId, pending?.success ? pending.pending : [])
      if (observedTerminalRevision > 0) {
        const summary = await window.joker.session.markSeen(sessionId, observedTerminalRevision).catch(() => null)
        if (summary && loadId === sessionLoadRef.current && isCurrentSelectedSessionGeneration(selection)) upsertSessionSummary(summary)
      }
    } catch (error) {
      if (loadId === sessionLoadRef.current && isCurrentSelectedSessionGeneration(selection)) {
        setSessionError(localizeError(language, error))
      }
    } finally {
      if (loadId === sessionLoadRef.current && isCurrentSelectedSessionGeneration(selection)) setSessionLoading(false)
    }
  }, [beginSelectedSessionGeneration, ensureSessionRuntime, isCurrentSelectedSessionGeneration, language, refreshGitStatus, setActiveProjectId, setActiveSession, setLatestUsage, setMessages, setPendingUserMessages, setProjects, setSessionError, setSessionLoading, upsertSessionSummary])

  const createSession = useCallback(async (): Promise<void> => {
    const session = await window.joker.session.create()
    ensureSessionRuntime(session.id)
    await refreshSessions()
    await loadSession(session.id)
  }, [ensureSessionRuntime, loadSession, refreshSessions])

  const deleteSession = useCallback(async (sessionId: string): Promise<void> => {
    if (isSessionRuntimeBusy(useStore.getState().sessionRuntimes[sessionId])) return
    await window.joker.session.delete(sessionId)
    activeRunsRef.current = clearActiveRun(activeRunsRef.current, sessionId)
    delete goalRunIdsRef.current[sessionId]
    removeSessionRuntime(sessionId)
    const remaining = await window.joker.session.listSummaries()
    setSessions(remaining)
    if (sessionId === sessionRef.current) {
      if (remaining[0]) await loadSession(remaining[0].id)
      else await createSession()
    }
  }, [createSession, loadSession, removeSessionRuntime, setSessions])

  const renameSession = useCallback(async (sessionId: string, title: string): Promise<void> => {
    if (isSessionRuntimeBusy(useStore.getState().sessionRuntimes[sessionId])) return
    const trimmed = title.trim()
    if (!trimmed) return
    await window.joker.session.rename(sessionId, trimmed)
    await refreshSessions()
  }, [refreshSessions])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        setSessionLoading(true)
        let sessions = await window.joker.session.listSummaries()
        if (cancelled) return
        if (sessions.length === 0) {
          const created = await window.joker.session.create()
          if (cancelled) return
          sessions = await window.joker.session.listSummaries()
          if (cancelled) return
          if (sessions.length === 0) throw new Error(`Session ${created.id} was not listed`)
        }
        setSessions(sessions)
        await loadSession(sessions[0].id)
      } catch (error) {
        if (!cancelled && sessionRef.current === null) {
          setSessionError(localizeError(language, error instanceof Error ? error.message : String(error)))
          setSessionLoading(false)
        }
      }
    })()
    return () => { cancelled = true }
  }, [loadSession, setSessionError, setSessionLoading, setSessions])

  useEffect(() => {
    const removeSummaryListener = window.joker.session.onSummaryChanged((event) => {
      if (event.type === 'delete') removeSessionSummary(event.sessionId)
      else if (event.summary) upsertSessionSummary(event.summary)
    })
    return removeSummaryListener
  }, [removeSessionSummary, upsertSessionSummary])

  useEffect(() => {
    void refreshProjects()
  }, [refreshProjects])

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    }
  }, [])

  useEffect(() => {
    let removeApprovalListener: (() => void) | undefined
    let removeApprovalResolvedListener: (() => void) | undefined
    let removePortListener: (() => void) | undefined
    let removeEventListener: (() => void) | undefined
    removePortListener = window.joker.chat.onPort((port) => {
      portRef.current = port
      setStreamPortReady(true)
      removeEventListener?.()
      removeEventListener = window.joker.chat.onEvent(port, (event: StreamEvent) => {
        const previousRuns = activeRunsRef.current
        const nextRuns = adoptQueuedRunOnEvent(previousRuns, event)
        if (!acceptsRunEvent(nextRuns, event)) return
        const adoptedQueuedRun = nextRuns !== previousRuns
        activeRunsRef.current = completeRunOnEvent(nextRuns, event)
        if (event.type === 'token') {
          queueToken(event)
        } else {
          flushTokenBuffer()
          dispatchRunActivity(event.sessionId, event)
        }
        switch (event.type) {
          case 'queue-updated':
            setPendingUserMessages(event.sessionId, event.pending)
            break
          case 'message-queued':
            void window.joker.session.pending(event.sessionId).then((result) => {
              if (result.success) setPendingUserMessages(event.sessionId, result.pending)
            })
            break
          case 'message-applied':
            if (event.disposition === 'queue' && adoptedQueuedRun) {
              setStreaming(event.sessionId, true)
              const pending = useStore.getState().sessionRuntimes[event.sessionId]?.pendingUserMessages.find((item) => item.message.id === event.pendingMessageId)
              dispatchRunActivity(event.sessionId, { type: 'send-accepted', runId: event.runId, sessionId: event.sessionId, runMode: pending?.message.runMode ?? 'chat' })
            }
            void window.joker.session.pending(event.sessionId).then((result) => {
              if (result.success) setPendingUserMessages(event.sessionId, result.pending)
            })
            break
          case 'message-deferred':
            if (sessionRef.current === event.sessionId) setSessionError(language === 'zh' ? '当前运行无法立即应用该引导，已排队到下一轮。' : 'The current run could not apply that guide, so it was queued for the next turn.')
            void window.joker.session.pending(event.sessionId).then((result) => {
              if (result.success) setPendingUserMessages(event.sessionId, result.pending)
            })
            break
          case 'step-start':
            break
          case 'message-start':
            if (sessionRef.current === event.sessionId && event.providerName && event.modelName && lastModelRef.current &&
              (lastModelRef.current.provider !== event.providerName || lastModelRef.current.model !== event.modelName)) {
              setModelSwitchNotice({ provider: event.providerName, model: event.modelName })
              if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
              noticeTimerRef.current = window.setTimeout(() => setModelSwitchNotice(null), 3200)
            }
            if (sessionRef.current === event.sessionId) lastModelRef.current = { provider: event.providerName, model: event.modelName }
            setStreamModel(event.sessionId, event.providerName, event.modelName)
            setStreamRunMode(event.sessionId, event.runMode ?? 'chat')
            startStream(event.sessionId)
            break
          case 'context-usage':
            setContextUsage(event.sessionId, event.usage)
            break
          case 'token':
            break
          case 'tool-call':
            addPendingToolCall(event.sessionId, { toolCallId: event.toolCallId, toolName: event.toolName, input: event.input, status: 'running' })
            break
          case 'tool-result':
            resolveToolCall(event.sessionId, event.toolCallId, event.toolName, event.output, event.metadata)
            break
          case 'tool-error':
            failToolCall(event.sessionId, event.toolCallId, event.toolName, localizeError(language, event.error))
            break
          case 'subagent-update':
            updateSubagentActivity(event.sessionId, event.activity)
            break
          case 'message-end':
            setLatestUsage(event.sessionId, event.usage ?? null)
            break
          case 'goal-update':
            setSessionGoal(event.sessionId, event.goal)
            if (event.goal?.status === 'validating' && event.goal.currentInvocationIds.validation === undefined) {
              void window.joker.session.get(event.sessionId).then((session) => {
                if (!session) return
                if (sessionRef.current === event.sessionId) setMessages(session.messages)
                resetTransientState(event.sessionId)
                setStreaming(event.sessionId, true)
              })
            }
            break
          case 'error':
            failRunningToolCalls(event.sessionId, localizeError(language, event.error))
            if (sessionRef.current === event.sessionId) setSessionError(localizeError(language, event.error))
            break
          case 'abort':
            failRunningToolCalls(event.sessionId, language === 'zh' ? '操作已停止' : 'Operation stopped')
            if (sessionRef.current === event.sessionId && goalRunIdsRef.current[event.sessionId] === event.runId) setSessionError(t(language, 'goal.pausing'))
            break
          case 'done':
            resetTransientState(event.sessionId)
            if (goalRunIdsRef.current[event.sessionId] === event.runId) delete goalRunIdsRef.current[event.sessionId]
            void (async () => {
              const session = await window.joker.session.get(event.sessionId).catch(() => null)
              if (session) {
                const lastAssistant = [...session.messages].reverse().find((message) => message.role === 'assistant' && message.usage)
                setLatestUsage(event.sessionId, lastAssistant?.usage ?? null)
                if (sessionRef.current === event.sessionId) setMessages(session.messages)
              }
              await refreshSessions()
            })()
            break
        }
      })
    })
    void window.joker.approval.listPending().then(setApprovals).catch(() => undefined)
    removeApprovalListener = window.joker.approval.onRequest((req: ApprovalRequest) => {
      addApproval(req)
    })
    removeApprovalResolvedListener = window.joker.approval.onResolved((event) => removeApproval(event.requestId))
    return () => {
      flushTokenBuffer()
      removeApprovalListener?.()
      removeApprovalResolvedListener?.()
      removeEventListener?.()
      removePortListener?.()
    }
  }, [addApproval, dispatchRunActivity, failRunningToolCalls, failToolCall, flushTokenBuffer, language, queueToken, refreshSessions, removeApproval, resetTransientState, resolveToolCall, setApprovals, setContextUsage, setMessages, setPendingUserMessages, setSessionError, setSessionGoal, setStreamModel, setStreamRunMode, setStreaming, startStream, updateSubagentActivity])

  const handleGoal = useCallback(async (command: GoalCommandMatch, draft: { skillIds?: string[] }): Promise<boolean> => {
    const sessionId = sessionRef.current
    if (!sessionId || sessionLoading || sendStarting || (streaming && command.action !== 'pause')) {
      setSessionError(t(language, !sessionId || sessionLoading ? 'message.sessionNotReady' : 'message.sendBusy'))
      return false
    }
    if (streaming && command.action === 'pause') {
      abortCurrentRun()
      setSessionError(t(language, 'goal.pausing'))
      return true
    }
    setSessionError(null)
    try {
      const inspected = await window.joker.session.goalInspect(sessionId)
      const current = inspected.goal
      const cas = current ? { goalId: current.id, generation: current.generation, revision: current.revision } satisfies GoalCas : undefined
      let result
      if (command.action === 'inspect') {
        if (!current) setSessionError(t(language, 'goal.empty'))
        else setSessionError(t(language, 'goal.inspected', { status: current.status, round: current.currentRound, max: current.maxRounds }))
        await refreshSessions()
        return true
      }
      if (command.action === 'create' || command.action === 'replace') {
        const input = {
          objective: command.argument,
          executionContext: {
            ...(activeProjectId ? { projectId: activeProjectId } : {}),
            skillIds: draft.skillIds ?? [],
            reasoningLevel
          }
        }
        result = command.action === 'create'
          ? await window.joker.session.goalCreate(sessionId, input)
          : await window.joker.session.goalReplace(sessionId, input)
      } else {
        if (!cas) {
          setSessionError(t(language, 'goal.empty'))
          return false
        }
        result = command.action === 'pause'
          ? await window.joker.session.goalPause(sessionId, { ...cas, stopReason: 'user-paused' })
          : command.action === 'resume'
            ? await window.joker.session.goalResume(sessionId, cas)
            : await window.joker.session.goalClear(sessionId, cas)
      }
      if (!result.success) {
        setSessionError(t(language, 'goal.saveFailed'))
        return false
      }
      await refreshSessions()
      if (command.action === 'clear' || command.action === 'pause') {
        setSessionError(t(language, command.action === 'clear' ? 'goal.cleared' : 'goal.paused'))
        return true
      }
      const port = portRef.current
      if (!port) {
        setSessionError(t(language, 'message.channelNotReady'))
        return false
      }
      const runId = crypto.randomUUID()
      activeRunsRef.current = setActiveRun(activeRunsRef.current, { runId, sessionId })
      goalRunIdsRef.current[sessionId] = runId
      if (!window.joker.chat.startGoal(port, sessionId, runId)) {
        activeRunsRef.current = clearActiveRun(activeRunsRef.current, sessionId, runId)
        delete goalRunIdsRef.current[sessionId]
        setSessionError(t(language, 'message.channelNotReady'))
        return false
      }
      dispatchRunActivity(sessionId, { type: 'send-accepted', runId, sessionId, runMode: 'chat' })
      setStreaming(sessionId, true)
      setSessionError(t(language, command.action === 'resume' ? 'goal.resumed' : 'goal.saved'))
      return true
    } catch {
      setSessionError(t(language, 'goal.saveFailed'))
      return false
    }
  }, [abortCurrentRun, activeProjectId, language, reasoningLevel, refreshSessions, sendStarting, sessionLoading, setSessionError, setStreaming, streaming])

  const handleGoalAction = useCallback(async (action: 'pause' | 'resume' | 'clear'): Promise<void> => {
    await handleGoal({ command: 'goal', action, argument: '' }, {})
  }, [handleGoal])

  const handleCompact = useCallback(async (): Promise<boolean> => {
    const sessionId = sessionRef.current
    const runtimeBusy = sessionId ? isSessionRuntimeBusy(useStore.getState().sessionRuntimes[sessionId]) : false
    if (!sessionId || sessionLoading || runtimeBusy) {
      setSessionError(t(language, !sessionId || sessionLoading ? 'message.sessionNotReady' : 'message.sendBusy'))
      return false
    }
    setSessionError(t(language, 'compact.running'))
    try {
      const result = await window.joker.session.compact(sessionId)
      if (sessionRef.current !== sessionId) return false
      if (result.changed) {
        setSessionError(t(language, 'compact.success', { before: result.beforeTokens, after: result.afterTokens }))
        await refreshSessions()
        return true
      }
      if (result.error === 'not-enough-history') {
        setSessionError(t(language, 'compact.unchanged'))
        return true
      }
      if (result.error === 'stale-session') {
        setSessionError(t(language, 'compact.stale'))
        return false
      }
      setSessionError(t(language, 'compact.failed', { error: localizeError(language, result.message ?? result.error ?? '') }))
      return false
    } catch (error) {
      setSessionError(t(language, 'compact.failed', { error: localizeError(language, error) }))
      return false
    }
  }, [language, refreshSessions, sendStarting, sessionLoading, setSessionError, streaming])

  const handleSend = useCallback(async (draft: { text: string; images: ChatImagePart[]; skillIds?: string[]; runMode: RunMode; command?: { type: 'goal' | 'plan' } }, action: 'send' | 'queue' | 'steer' = streaming ? 'queue' : 'send'): Promise<boolean> => {
    const sessionId = sessionRef.current
    if (action !== 'send') {
      const port = portRef.current
      if (!sessionId || sessionLoading || !port || sendStarting) {
        setSessionError(t(language, !sessionId || sessionLoading ? 'message.sessionNotReady' : !port ? 'message.channelNotReady' : 'message.sendBusy'))
        return false
      }
      let messageText = draft.text
      const parts = [...(messageText ? [{ type: 'text' as const, text: messageText }] : []), ...draft.images]
      const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: messageText, parts: parts.length > 0 ? parts : undefined, skillIds: draft.skillIds, runMode: draft.runMode, createdAt: Date.now() }
      const expectedRunId = action === 'steer' ? activeRunForSession(activeRunsRef.current, sessionId)?.runId : undefined
      const sent = window.joker.chat.enqueue(port, sessionId, userMsg, action, expectedRunId, {
        reasoningLevel,
        skillIds: draft.skillIds,
        projectId: draft.runMode === 'chat' ? activeProjectId ?? undefined : undefined,
        runMode: draft.runMode
      })
      if (!sent) {
        setSessionError(t(language, 'message.channelNotReady'))
        return false
      }
      return true
    }
    const unavailable = sendUnavailableReason({ sessionId, sessionLoading, streaming, starting: sendStarting, portReady: streamPortReady })
    if (unavailable) {
      setSessionError(t(language, unavailable === 'channel' ? 'message.channelNotReady' : unavailable === 'busy' ? 'message.sendBusy' : 'message.sessionNotReady'))
      return false
    }
    const port = portRef.current
    if (!sessionId || !port) return false
    setSendStarting(sessionId, true)
    setSessionError(null)
    const intent: ChatIntent | undefined = draft.command?.type === 'plan' ? 'plan' : undefined
    let messageText = draft.text
    if (intent === 'plan' && !messageText.trim()) {
      const session = await window.joker.session.get(sessionId).catch(() => null)
      messageText = session?.goal?.objective ?? ''
      if (!messageText) {
        setSessionError(t(language, 'plan.requiresTaskOrGoal'))
        setSendStarting(sessionId, false)
        return false
      }
    }
    const parts = [...(messageText ? [{ type: 'text' as const, text: messageText }] : []), ...draft.images]
    const skillIds = draft.runMode === 'chat' && intent === undefined && draft.skillIds?.length ? draft.skillIds : undefined
    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: messageText, parts: parts.length > 0 ? parts : undefined, skillIds, runMode: draft.runMode, createdAt: Date.now() }
    const nextMessages = [...messages, userMsg]
    addMessage(userMsg)
    try {
      const saved = await window.joker.session.append(sessionId, userMsg)
      if (!saved) throw new Error(t(language, 'message.saveFailed'))
      const runId = crypto.randomUUID()
      activeRunsRef.current = setActiveRun(activeRunsRef.current, { runId, sessionId })
      dispatchRunActivity(sessionId, { type: 'send-accepted', runId, sessionId, runMode: draft.runMode })
      const sent = window.joker.chat.send(port, sessionId, nextMessages, reasoningLevel, skillIds, draft.runMode === 'chat' ? activeProjectId ?? undefined : undefined, runId, draft.runMode, intent)
      if (!sent) {
        activeRunsRef.current = clearActiveRun(activeRunsRef.current, sessionId, runId)
        const restored = await window.joker.session.replaceMessages(sessionId, messages)
        if (restored && sessionRef.current === sessionId) removeMessage(userMsg.id)
        if (sessionRef.current === sessionId) setSessionError(t(language, 'message.channelNotReady'))
        return false
      }
      setStreaming(sessionId, true)
      void refreshSessions().catch((error) => {
        if (sessionRef.current === sessionId) setSessionError(localizeError(language, error))
      })
      return true
    } catch (error) {
      const activeRun = activeRunForSession(activeRunsRef.current, sessionId)
      activeRunsRef.current = clearActiveRun(activeRunsRef.current, sessionId, activeRun?.runId)
      const restored = await window.joker.session.replaceMessages(sessionId, messages).catch(() => false)
      if (restored && sessionRef.current === sessionId) removeMessage(userMsg.id)
      if (sessionRef.current === sessionId) setSessionError(localizeError(language, error))
      return false
    } finally {
      setSendStarting(sessionId, false)
    }
  }, [activeProjectId, addMessage, dispatchRunActivity, language, messages, reasoningLevel, refreshSessions, removeMessage, sendStarting, sessionLoading, setSessionError, setStreaming, streamPortReady, streaming])

  const handleCopyMessage = useCallback((text: string): void => {
    inputBoxRef.current?.insertText(text)
  }, [])

  const handleCopyLink = useCallback((url: string): void => {
    inputBoxRef.current?.insertLink(url)
  }, [])

  const handleRunModeChange = useCallback((mode: RunMode): void => {
    const sessionId = sessionRef.current
    if (sessionId) setActiveRunMode(sessionId, mode)
  }, [setActiveRunMode])

  const handleEditMessage = useCallback(async (messageId: string, text: string): Promise<boolean> => {
    const sessionId = sessionRef.current
    if (!sessionId || streaming) return false
    const selection: SelectedSessionGeneration = {
      sessionId,
      generation: selectedSessionGenerationRef.current
    }
    const index = messages.findIndex((message) => message.id === messageId)
    const original = messages[index]
    if (index < 0 || !original || original.role !== 'user' || original.parts?.some((part) => part.type === 'image')) return false
    const editedMessage: ChatMessage = {
      ...original,
      id: crypto.randomUUID(),
      content: text,
      parts: [{ type: 'text', text }],
      createdAt: Date.now()
    }
    const nextMessages = [...messages.slice(0, index), editedMessage]
    const saved = await window.joker.session.replaceMessages(sessionId, nextMessages)
    if (!isCurrentSelectedSessionGeneration(selection)) return saved
    if (!saved) {
      setSessionError(localizeError(language, language === 'zh' ? '编辑消息保存失败' : 'Failed to save edited message'))
      return false
    }
    setMessages(nextMessages)
    resetTransientState(sessionId)
    const port = portRef.current
    if (!port) {
      setSessionError(t(language, 'message.channelNotReady'))
      return false
    }
    const runId = crypto.randomUUID()
    activeRunsRef.current = setActiveRun(activeRunsRef.current, { runId, sessionId })
    const runMode = editedMessage.runMode ?? 'chat'
    const sent = window.joker.chat.send(port, sessionId, nextMessages, reasoningLevel, runMode === 'chat' ? editedMessage.skillIds : undefined, runMode === 'chat' ? activeProjectId ?? undefined : undefined, runId, runMode)
    if (!sent) {
      activeRunsRef.current = clearActiveRun(activeRunsRef.current, sessionId, runId)
      await window.joker.session.replaceMessages(sessionId, messages)
      if (isCurrentSelectedSessionGeneration(selection)) {
        setMessages(messages)
        setSessionError(t(language, 'message.channelNotReady'))
      }
      return false
    }
    dispatchRunActivity(sessionId, { type: 'send-accepted', runId, sessionId, runMode })
    setStreaming(sessionId, true)
    return true
  }, [activeProjectId, dispatchRunActivity, isCurrentSelectedSessionGeneration, language, messages, reasoningLevel, resetTransientState, setMessages, setSessionError, setStreaming, streaming])

  const handleAbort = useCallback(() => {
    abortCurrentRun()
  }, [abortCurrentRun])

  const handleCancelPending = useCallback(async (pendingMessageId: string): Promise<void> => {
    const sessionId = sessionRef.current
    const port = portRef.current
    if (!sessionId || !port) return
    if (!window.joker.chat.cancelPending(port, sessionId, pendingMessageId)) {
      setSessionError(t(language, 'message.channelNotReady'))
    }
  }, [language, setSessionError])
  const handleSteerPending = useCallback(async (pendingMessageId: string): Promise<void> => {
    const sessionId = sessionRef.current
    const port = portRef.current
    if (!sessionId || !port) return
    const activeRun = activeRunForSession(activeRunsRef.current, sessionId)
    if (!activeRun || activeRun.abortRequested) return
    if (!window.joker.chat.steerPending(port, sessionId, pendingMessageId, activeRun.runId)) {
      setSessionError(t(language, 'message.channelNotReady'))
    }
  }, [language, setSessionError])

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 't') {
        event.preventDefault()
        const levels: ReasoningLevel[] = ['auto', 'none', 'low', 'medium', 'high']
        setReasoningLevel(levels[(levels.indexOf(reasoningLevel) + 1) % levels.length])
      }
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [reasoningLevel, setReasoningLevel])


  return (
    <div className="flex h-screen overflow-hidden bg-[var(--color-bg)]">
      <Sidebar onCreate={createSession} onCreateInConversation={() => inputBoxRef.current?.focus()} onSelect={(id) => void loadSession(id)} onDelete={(id) => void deleteSession(id)} onRename={(id, title) => void renameSession(id, title)} />
      <main className="relative flex min-w-0 flex-1 flex-col">
        <ConversationPane onCopyLink={handleCopyLink} onCopyMessage={handleCopyMessage} onEditMessage={handleEditMessage} />
        <InputBox ref={inputBoxRef} onSend={handleSend} onCancelPending={handleCancelPending} onSteerPending={handleSteerPending} pendingUserMessages={pendingUserMessages} onGoal={handleGoal} onCompact={handleCompact} planCommandAvailable onAbort={handleAbort} streaming={streaming} goalActive={Boolean(sessionRef.current && goalRunIdsRef.current[sessionRef.current])} contextUsage={contextUsage} reasoningLevel={reasoningLevel} onReasoningLevelChange={setReasoningLevel} runMode={activeRunMode} onRunModeChange={handleRunModeChange} onProjectChange={selectProject} onProjectClear={clearProject} onProjectPick={pickProject} gitStatus={gitStatus} gitStatusLoading={gitStatusLoading} />
        {modelSwitchNotice && <div className="pointer-events-none absolute bottom-[76px] left-1/2 -translate-x-1/2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 text-[11px] text-[var(--color-text-muted)] shadow-lg">模型已切换 {modelSwitchNotice.provider} / {modelSwitchNotice.model}</div>}
      </main>
      <DetailPanel onGoalAction={handleGoalAction} />
      {pendingWindowApproval && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4" data-testid="window-approval-overlay">
          <div role="dialog" aria-modal="true" className="max-h-[min(720px,90vh)] w-full max-w-xl overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl">
            <ApprovalPanel key={pendingWindowApproval.requestId} approval={pendingWindowApproval} />
          </div>
        </div>
      )}
    </div>
  )
}
