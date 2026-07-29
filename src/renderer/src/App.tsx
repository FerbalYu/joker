import { useEffect, useRef, useCallback, useState } from 'react'
import Sidebar from './components/Sidebar'
import MessageStream from './components/MessageStream'
import DetailPanel from './components/DetailPanel'
import InputBox, { type InputBoxHandle } from './components/InputBox'
import { useStore } from './store'
import { t } from './i18n'
import type { ChatImagePart, ChatMessage, StreamEvent, ApprovalRequest, ReasoningLevel, GitStatus } from '@shared/types'

export default function App(): React.JSX.Element {
  const portRef = useRef<MessagePort | null>(null)
  const inputBoxRef = useRef<InputBoxHandle>(null)
  const sessionRef = useRef<string | null>(null)
  const sessionLoadRef = useRef(0)
  const activeRunRef = useRef<{ runId: string; sessionId: string } | null>(null)
  const messages = useStore((s) => s.messages)
  const streamText = useStore((s) => s.streamText)
  const streamSegments = useStore((s) => s.streamSegments)
  const streaming = useStore((s) => s.streaming)
  const contextUsage = useStore((s) => s.contextUsage)
  const reasoningLevel = useStore((s) => s.reasoningLevel)
  const pendingToolCalls = useStore((s) => s.pendingToolCalls)
  const sessionLoading = useStore((s) => s.sessionLoading)
  const language = useStore((s) => s.language)
  const [modelSwitchNotice, setModelSwitchNotice] = useState<{ provider: string; model: string } | null>(null)
  const lastModelRef = useRef<{ provider?: string; model?: string } | null>(null)
  const noticeTimerRef = useRef<number | null>(null)

  const addMessage = useStore((s) => s.addMessage)
  const removeMessage = useStore((s) => s.removeMessage)
  const setMessages = useStore((s) => s.setMessages)
  const startStream = useStore((s) => s.startStream)
  const appendToken = useStore((s) => s.appendToken)
  const commitStream = useStore((s) => s.commitStream)
  const resetTransientState = useStore((s) => s.resetTransientState)
  const setStreaming = useStore((s) => s.setStreaming)
  const setStreamModel = useStore((s) => s.setStreamModel)
  const setContextUsage = useStore((s) => s.setContextUsage)
  const setLatestUsage = useStore((s) => s.setLatestUsage)
  const setReasoningLevel = useStore((s) => s.setReasoningLevel)
  const addPendingToolCall = useStore((s) => s.addPendingToolCall)
  const resolveToolCall = useStore((s) => s.resolveToolCall)
  const failToolCall = useStore((s) => s.failToolCall)
  const failRunningToolCalls = useStore((s) => s.failRunningToolCalls)
  const addApproval = useStore((s) => s.addApproval)
  const setSessions = useStore((s) => s.setSessions)
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

  const abortCurrentRun = useCallback((): void => {
    const activeRun = activeRunRef.current
    if (portRef.current && activeRun) window.joker.chat.abort(portRef.current, activeRun.runId)
    activeRunRef.current = null
    setStreaming(false)
  }, [])

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
    setGitStatus(result.success ? (result.status ?? null) : { isRepository: false, branch: null, detached: false, ahead: 0, behind: 0, changed: 0, untracked: 0, conflicted: 0, clean: false, available: true, error: result.error ?? t(language, 'project.gitStatusFailed') })
    setGitStatusLoading(false)
  }, [language])

  const refreshProjects = useCallback(async (): Promise<boolean> => {
    setProjectLoading(true)
    const result = await window.joker.project.get()
    if (!result.success || !result.state) {
      setProjectError(result.error ?? t(language, 'project.loadFailed'))
      setProjectLoading(false)
      return false
    }
    setProjects(result.state.projects)
    setProjectLoading(false)
    return true
  }, [language, setProjectError, setProjectLoading, setProjects])

  const selectProject = useCallback(async (projectId: string): Promise<boolean> => {
    if (streaming) return false
    setProjectLoading(true)
    const result = await window.joker.project.select(projectId)
    if (!result.success || !result.state) {
      setProjectError(result.error ?? t(language, 'project.selectFailed'))
      setProjectLoading(false)
      return false
    }
    setProjects(result.state.projects)
    const sessionId = sessionRef.current
    if (!sessionId || !(await window.joker.session.setProject(sessionId, projectId))) {
      setProjectError(t(language, 'project.selectFailed'))
      setProjectLoading(false)
      return false
    }
    setActiveProjectId(projectId)
    setProjectLoading(false)
    await refreshGitStatus(projectId)
    return true
  }, [language, refreshGitStatus, setActiveProjectId, setProjectError, setProjectLoading, setProjects, streaming])

  const pickProject = useCallback(async (): Promise<boolean> => {
    if (streaming) return false
    setProjectLoading(true)
    const result = await window.joker.project.pick()
    if (!result.success || !result.state) {
      if (!result.canceled) setProjectError(result.error ?? t(language, 'project.selectFailed'))
      setProjectLoading(false)
      return false
    }
    const projectId = result.state.activeProjectId
    const sessionId = sessionRef.current
    if (!projectId || !sessionId || !(await window.joker.session.setProject(sessionId, projectId))) {
      setProjectError(t(language, 'project.selectFailed'))
      setProjectLoading(false)
      return false
    }
    setProjects(result.state.projects)
    setActiveProjectId(projectId)
    setProjectLoading(false)
    await refreshGitStatus(projectId)
    return true
  }, [language, refreshGitStatus, setActiveProjectId, setProjectError, setProjectLoading, setProjects, streaming])

  const clearProject = useCallback(async (): Promise<boolean> => {
    if (streaming) return false
    const sessionId = sessionRef.current
    if (!sessionId || !(await window.joker.session.setProject(sessionId, null))) return false
    setActiveProjectId(null)
    await refreshGitStatus(null)
    return true
  }, [refreshGitStatus, setActiveProjectId, streaming])

  const refreshSessions = useCallback(async (): Promise<void> => {
    const sessions = await window.joker.session.list()
    setSessions(sessions)
  }, [setSessions])

  const loadSession = useCallback(async (sessionId: string): Promise<void> => {
    abortCurrentRun()
    const loadId = ++sessionLoadRef.current
    setSessionLoading(true)
    setSessionError(null)
    sessionRef.current = sessionId
    resetTransientState()
    const session = await window.joker.session.get(sessionId)
    if (loadId !== sessionLoadRef.current || sessionRef.current !== sessionId) return
    if (!session) {
      setSessionError('Session not found')
      setMessages([])
      setActiveProjectId(null)
      await refreshGitStatus(null)
    } else {
      setMessages(session.messages)
      let projectId = session.projectId ?? null
      if (projectId && !useStore.getState().projects.some((project) => project.id === projectId)) {
        const projectResult = await window.joker.project.get()
        if (projectResult.success && projectResult.state) {
          setProjects(projectResult.state.projects)
        }
      }
      if (projectId && !useStore.getState().projects.some((project) => project.id === projectId)) projectId = null
      setActiveProjectId(projectId)
      await refreshGitStatus(projectId)
      const lastAssistant = [...session.messages].reverse().find((message) => message.role === 'assistant' && message.usage)
      setLatestUsage(lastAssistant?.usage ?? null)
    }
    setActiveSession(sessionId)
    setSessionLoading(false)
  }, [abortCurrentRun, refreshGitStatus, resetTransientState, setActiveProjectId, setActiveSession, setLatestUsage, setMessages, setProjects, setSessionError, setSessionLoading])

  const createSession = useCallback(async (): Promise<void> => {
    portRef.current && abortCurrentRun()
    const session = await window.joker.session.create()
    await refreshSessions()
    await loadSession(session.id)
  }, [abortCurrentRun, loadSession, refreshSessions])

  const deleteSession = useCallback(async (sessionId: string): Promise<void> => {
    if (sessionId === sessionRef.current) abortCurrentRun()
    await window.joker.session.delete(sessionId)
    const remaining = await window.joker.session.list()
    setSessions(remaining)
    if (sessionId === sessionRef.current) {
      if (remaining[0]) await loadSession(remaining[0].id)
      else await createSession()
    }
  }, [abortCurrentRun, createSession, loadSession, setSessions])

  const renameSession = useCallback(async (sessionId: string, title: string): Promise<void> => {
    const trimmed = title.trim()
    if (!trimmed) return
    await window.joker.session.rename(sessionId, trimmed)
    await refreshSessions()
  }, [refreshSessions])

  useEffect(() => {
    void (async () => {
      try {
        setSessionLoading(true)
        let sessions = await window.joker.session.list()
        if (sessions.length === 0) {
          const created = await window.joker.session.create()
          sessions = [created]
        }
        setSessions(sessions)
        await loadSession(sessions[0].id)
      } catch (error) {
        setSessionError(error instanceof Error ? error.message : String(error))
        setSessionLoading(false)
      }
    })()
  }, [loadSession, setSessionError, setSessionLoading, setSessions])

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
    window.joker.chat.onPort((port) => {
      portRef.current = port
      window.joker.chat.onEvent(port, (event: StreamEvent) => {
        if (event.sessionId !== sessionRef.current) return
        const activeRun = activeRunRef.current
        if (activeRun && event.runId !== activeRun.runId) return
        if (!activeRun && event.type !== 'done') return
        if (activeRun && event.type === 'done') activeRunRef.current = null
        switch (event.type) {
          case 'message-start':
            if (event.providerName && event.modelName && lastModelRef.current &&
              (lastModelRef.current.provider !== event.providerName || lastModelRef.current.model !== event.modelName)) {
              setModelSwitchNotice({ provider: event.providerName, model: event.modelName })
              if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
              noticeTimerRef.current = window.setTimeout(() => setModelSwitchNotice(null), 3200)
            }
            lastModelRef.current = { provider: event.providerName, model: event.modelName }
            startStream()
            break
          case 'context-usage':
            setContextUsage(event.usage)
            break
          case 'token':
            appendToken(event.text)
            break
          case 'tool-call':
            addPendingToolCall({ toolCallId: event.toolCallId, toolName: event.toolName, input: event.input, status: 'running' })
            break
          case 'tool-result':
            resolveToolCall(event.toolCallId, event.toolName, event.output, event.metadata)
            break
          case 'tool-error':
            failToolCall(event.toolCallId, event.toolName, event.error)
            break
          case 'message-end': {
            setLatestUsage(event.usage ?? null)
            const assistantMessage = commitStream(event.messageId, event.usage)
            if (assistantMessage) void window.joker.session.append(event.sessionId, assistantMessage).then(() => refreshSessions())
            break
          }
          case 'error': {
            failRunningToolCalls(event.error)
            const failedStream = useStore.getState()
            if (failedStream.pendingToolCalls.length > 0 || failedStream.streamText || failedStream.streamSegments.length > 0) {
              const partialMessage = commitStream(crypto.randomUUID())
              if (partialMessage) void window.joker.session.append(event.sessionId, partialMessage).then(() => refreshSessions())
            }
            const errorMessage: ChatMessage = {
              id: crypto.randomUUID(), role: 'assistant', content: t(language, 'message.error', { error: event.error }), createdAt: Date.now()
            }
            addMessage(errorMessage)
            void window.joker.session.append(event.sessionId, errorMessage).then(() => refreshSessions())
            resetTransientState()
            break
          }
          case 'abort': {
            failRunningToolCalls(language === 'zh' ? '操作已停止' : 'Operation stopped')
            const abortedStream = useStore.getState()
            if (abortedStream.pendingToolCalls.length > 0 || abortedStream.streamText || abortedStream.streamSegments.length > 0) {
              const partialMessage = commitStream(crypto.randomUUID())
              if (partialMessage) void window.joker.session.append(event.sessionId, partialMessage).then(() => refreshSessions())
            }
            setStreaming(false)
            break
          }
          case 'done':
            setStreaming(false)
            break
        }
      })
    })
    removeApprovalListener = window.joker.approval.onRequest((req: ApprovalRequest) => {
      addApproval(req)
    })
    return () => removeApprovalListener?.()
  }, [addApproval, addMessage, appendToken, commitStream, failRunningToolCalls, failToolCall, language, refreshSessions, resetTransientState, resolveToolCall, setContextUsage, setStreamModel, setStreaming, startStream])

  const handleSend = useCallback((draft: { text: string; images: ChatImagePart[]; skillIds?: string[] }) => {
    const sessionId = sessionRef.current
    if (!sessionId || sessionLoading || streaming) return
    const parts = [...(draft.text ? [{ type: 'text' as const, text: draft.text }] : []), ...draft.images]
    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: draft.text, parts: parts.length > 0 ? parts : undefined, skillIds: draft.skillIds?.length ? draft.skillIds : undefined, createdAt: Date.now() }
    const nextMessages = [...messages, userMsg]
    addMessage(userMsg)
    void window.joker.session.append(sessionId, userMsg).then(async (saved) => {
      if (!saved) {
        removeMessage(userMsg.id)
        setSessionError(t(language, 'message.imageSaveFailed'))
        return
      }
      if (sessionRef.current !== sessionId) return
      const port = portRef.current
      if (!port) return
      const runId = crypto.randomUUID()
      activeRunRef.current = { runId, sessionId }
      window.joker.chat.send(port, sessionId, nextMessages, reasoningLevel, draft.skillIds, activeProjectId ?? undefined, runId)
      await refreshSessions()
    })
  }, [activeProjectId, addMessage, messages, reasoningLevel, refreshSessions, removeMessage, sessionLoading, setSessionError, streaming])

  const handleCopyMessage = useCallback((text: string): void => {
    inputBoxRef.current?.insertText(text)
  }, [])

  const handleEditMessage = useCallback(async (messageId: string, text: string): Promise<boolean> => {
    const sessionId = sessionRef.current
    if (!sessionId || streaming) return false
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
    if (!saved) {
      setSessionError(language === 'zh' ? '编辑消息保存失败' : 'Failed to save edited message')
      return false
    }
    setMessages(nextMessages)
    resetTransientState()
    const port = portRef.current
    if (!port) return false
    const runId = crypto.randomUUID()
    activeRunRef.current = { runId, sessionId }
    window.joker.chat.send(port, sessionId, nextMessages, reasoningLevel, editedMessage.skillIds, activeProjectId ?? undefined, runId)
    return true
  }, [activeProjectId, language, messages, reasoningLevel, resetTransientState, setMessages, setSessionError, streaming])

  const handleAbort = useCallback(() => {
    abortCurrentRun()
  }, [abortCurrentRun])
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
      <Sidebar onCreate={createSession} onSelect={(id) => void loadSession(id)} onDelete={(id) => void deleteSession(id)} onRename={(id, title) => void renameSession(id, title)} />
      <main className="relative flex min-w-0 flex-1 flex-col">
        <MessageStream messages={messages} streamText={streamText} streamSegments={streamSegments} streaming={streaming} pendingToolCalls={pendingToolCalls} onCopyLink={(url) => inputBoxRef.current?.insertLink(url)} onCopyMessage={handleCopyMessage} onEditMessage={handleEditMessage} />
        <InputBox ref={inputBoxRef} onSend={handleSend} onAbort={handleAbort} streaming={streaming} contextUsage={contextUsage} reasoningLevel={reasoningLevel} onReasoningLevelChange={setReasoningLevel} onProjectChange={selectProject} onProjectClear={clearProject} onProjectPick={pickProject} gitStatus={gitStatus} gitStatusLoading={gitStatusLoading} />
        {modelSwitchNotice && <div className="pointer-events-none absolute bottom-[76px] left-1/2 -translate-x-1/2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 text-[11px] text-[var(--color-text-muted)] shadow-lg">模型已切换 {modelSwitchNotice.provider} / {modelSwitchNotice.model}</div>}
      </main>
      <DetailPanel />
    </div>
  )
}
