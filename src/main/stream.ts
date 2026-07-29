import { BrowserWindow, MessageChannelMain } from 'electron'
import { runAgent } from './agent/loop'
import { createApprovalGate, cancelApprovalsForRun, cleanupApprovalWindow } from './agent/approval'
import { buildToolSet, type ToolDefinition, type ToolContext } from './tools/registry'
import { fsTools } from './tools/fs'
import { bashTools } from './tools/bash'
import { searchTools } from './tools/grep'
import { todoTools } from './tools/todo'
import { subagentTools } from './tools/subagent'
import { getSession } from './store/sessions'
import { resolveProjectPath } from './store/projects'
import { getMcpTools } from './tools/mcp-bridge'
import { webTools } from './tools/web'
import { imageTools } from './tools/image'
import { gitTools } from './tools/git'
import { buildCapabilitySnapshot } from './agent/capabilities'
import { validateChatParts } from '../shared/messages'
import type { ChatMessage, ReasoningLevel, StreamEvent } from '@shared/types'
import type { ModelMessage, ToolSet } from 'ai'
import { StreamTransport } from './stream-transport'

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

function toModelMessages(messages: unknown[]): ModelMessage[] {
  return messages.map((message) => {
    if (!message || typeof message !== 'object') throw new Error('Invalid message')
    const value = message as Partial<ChatMessage>
    if (typeof value.role !== 'string' || typeof value.content !== 'string') throw new Error('Invalid message')
    if (value.parts !== undefined && !validateChatParts(value.parts)) throw new Error('Invalid image attachment')
    if (!value.parts) return { role: value.role as ModelMessage['role'], content: value.content } as ModelMessage
    const content = value.parts.map((part) => part.type === 'text' ? { type: 'text' as const, text: part.text } : { type: 'file' as const, data: part.data, mediaType: part.mediaType })
    return { role: value.role as ModelMessage['role'], content } as ModelMessage
  })
}

function buildAllTools(allowedMcpTools?: readonly string[]): ToolDefinition[] {
  return [...fsTools, ...bashTools, ...searchTools, ...todoTools, ...subagentTools, ...webTools, ...imageTools, ...gitTools, ...getMcpTools(allowedMcpTools)]
}

interface ActiveRun {
  controller: AbortController
  sessionId: string
  runId: string
  port: Electron.MessagePortMain
  transport: StreamTransport
}

const activeRuns = new Map<number, ActiveRun>()

/** Each window gets one MessagePort; approval IPC is registered during app initialization. */
export function setupStreaming(win: BrowserWindow): void {
  const { port1, port2 } = new MessageChannelMain()
  const transport = new StreamTransport({
    postMessage: (message) => port2.postMessage(message),
    onFlow: (flow) => port2.postMessage({ type: 'stream:flow', flow })
  })
  win.webContents.postMessage('stream:port', null, [port1])

  const onClosed = (): void => {
    abort(win.id)
    cleanupApprovalWindow(win.id)
    transport.close('BrowserWindow closed')
    port2.close()
    win.removeListener('closed', onClosed)
  }
  win.on('closed', onClosed)

  port2.on('message', (event: Electron.MessageEvent) => {
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
        handleSend(win, port2, transport, runId, sessionId, toModelMessages(data.messages), normalizeReasoningLevel(data.reasoningLevel), normalizeSkillIds(data.skillIds), typeof data.projectId === 'string' ? data.projectId : undefined)
      } catch (error) {
        void transport.send({ type: 'error', sessionId, runId, error: error instanceof Error ? error.message : 'Invalid message' })
        void transport.send({ type: 'done', sessionId, runId })
      }
    } else if (data.type === 'chat:abort') {
      const runId = typeof data.runId === 'string' ? data.runId : undefined
      abort(win.id, runId)
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
  messages: ModelMessage[],
  reasoningLevel: ReasoningLevel,
  skillIds?: string[],
  projectId?: string
): void {
  abort(win.id)
  const controller = new AbortController()
  const activeRun: ActiveRun = { controller, sessionId, runId, port, transport }
  activeRuns.set(win.id, activeRun)
  const onEvent = (event: StreamEvent): Promise<void> => {
    if (activeRuns.get(win.id)?.runId !== runId) return Promise.resolve()
    return transport.send({ ...event, runId }, controller.signal)
  }

  const workspacePath = projectId ? resolveProjectPath(projectId) : null
  if (projectId && !workspacePath) {
    onEvent({ type: 'error', sessionId, runId, error: 'Invalid or unavailable project' }).catch(() => undefined)
    onEvent({ type: 'done', sessionId, runId }).catch(() => undefined)
    activeRuns.delete(win.id)
    return
  }

  const toolContext: ToolContext = {
    workspacePath,
    sessionId,
    runId,
    approvalGate: createApprovalGate(win, sessionId, runId),
    abortSignal: controller.signal,
    onToolCall: (info) => { void info }
  }
  const capabilities = buildCapabilitySnapshot(skillIds, workspacePath)
  const tools: ToolSet = buildToolSet(buildAllTools(capabilities.allowedMcpTools), toolContext)
  runAgent({ sessionId, runId, messages, tools, reasoningLevel, capabilities, onEvent, signal: controller.signal }).finally(() => {
    if (activeRuns.get(win.id)?.runId === runId) activeRuns.delete(win.id)
    cancelApprovalsForRun({ windowId: win.id, sessionId, runId })
  })
}

export function abort(windowId: number, runId?: string): void {
  const active = activeRuns.get(windowId)
  if (!active || (runId && active.runId !== runId)) return
  active.controller.abort()
  active.transport.cancelRun(active.runId)
  cancelApprovalsForRun({ windowId, sessionId: active.sessionId, runId: active.runId })
}

export function getActiveRun(windowId: number): Pick<ActiveRun, 'sessionId' | 'runId'> | null {
  const active = activeRuns.get(windowId)
  return active ? { sessionId: active.sessionId, runId: active.runId } : null
}
