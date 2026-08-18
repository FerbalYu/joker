import { isStepCount, streamText } from 'ai'
import { createLanguageModel } from '../providers'
import { loadConfig, resolveActiveModel } from '../store/config'
import { streamUsageFromModelUsage } from '../agent/usage'
import { z } from 'zod'
import { buildToolSet, type ToolDefinition, type ToolResult, type ToolContext } from './registry'
import { readTool } from './fs'
import { grepTool, globTool } from './grep'
import { gitTools } from './git'
import { toolResultReadTool } from './tool-result-read'
import type { SubagentActivity, SubagentToolActivity } from '../../shared/types'

// Concurrency limiter — max 4 concurrent sub-agents.
const MAX_CONCURRENT_SUBAGENTS = 4
let runningSubagents = 0
type QueuedSubagentResult = SubagentRunResult

const queuedSubagents: Array<{
  run: () => Promise<QueuedSubagentResult>
  resolve: (value: QueuedSubagentResult | PromiseLike<QueuedSubagentResult>) => void
  reject: (reason?: unknown) => void
  signal?: AbortSignal
  onAbort?: () => void
}> = []

function abortError(): Error {
  return new Error('Aborted')
}

function runQueuedSubagent(run: () => Promise<QueuedSubagentResult>, signal?: AbortSignal): Promise<QueuedSubagentResult> {
  return new Promise<QueuedSubagentResult>((resolve, reject) => {
    const task: {
      run: () => Promise<QueuedSubagentResult>
      resolve: (value: QueuedSubagentResult | PromiseLike<QueuedSubagentResult>) => void
      reject: (reason?: unknown) => void
      signal?: AbortSignal
      onAbort?: () => void
    } = { run, resolve, reject, signal }
    const onAbort = (): void => {
      const index = queuedSubagents.indexOf(task)
      if (index < 0) return
      queuedSubagents.splice(index, 1)
      reject(abortError())
    }
    task.onAbort = onAbort
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    queuedSubagents.push(task)
    drainSubagentQueue()
  })
}

function drainSubagentQueue(): void {
  while (runningSubagents < MAX_CONCURRENT_SUBAGENTS && queuedSubagents.length > 0) {
    const task = queuedSubagents.shift()!
    task.signal?.removeEventListener('abort', task.onAbort!)
    if (task.signal?.aborted) {
      task.reject(abortError())
      continue
    }
    runningSubagents += 1
    void task.run().then(task.resolve, task.reject).finally(() => {
      runningSubagents -= 1
      drainSubagentQueue()
    })
  }
}

const READ_ONLY_SUBAGENT_TOOLS: ToolDefinition[] = [readTool, grepTool, globTool, ...gitTools, toolResultReadTool]

export function getReadonlySubagentToolNames(): string[] {
  return READ_ONLY_SUBAGENT_TOOLS.map((tool) => tool.name)
}

export interface SubagentRunResult {
  output: string
  usage: ReturnType<typeof streamUsageFromModelUsage>
  activity: SubagentActivity
}

export interface SubagentRunOptions {
  prompt: string
  context?: string
  toolContext: ToolContext
  model?: ReturnType<typeof createLanguageModel>
}

export async function runSubagent({ prompt, context: extraContext, toolContext, model }: SubagentRunOptions): Promise<SubagentRunResult> {
  if (toolContext.abortSignal?.aborted) throw new Error('Aborted')
  const maxSteps = 20
  const createdAt = Date.now()
  const activity: SubagentActivity = {
    id: crypto.randomUUID(),
    ...(toolContext.toolCallId ? { parentToolCallId: toolContext.toolCallId } : {}),
    task: boundedText(prompt, 240),
    status: 'queued',
    phase: 'queued',
    createdAt,
    updatedAt: createdAt,
    currentStep: 0,
    maxSteps,
    tools: []
  }
  const emit = async (update: Partial<SubagentActivity> = {}): Promise<void> => {
    Object.assign(activity, update, { updatedAt: Date.now() })
    await safeEmitActivity(toolContext, cloneActivity(activity))
  }
  await emit()

  try {
    return await runQueuedSubagent(async () => {
      if (toolContext.abortSignal?.aborted) throw new Error('Aborted')
      const activeModel = model ?? createLanguageModel(resolveActiveModel(loadConfig()))
      const workspaceLabel = toolContext.workspacePath ?? 'none (no working folder selected)'
      const startedAt = Date.now()
      await emit({ status: 'running', phase: 'starting', startedAt })
      let fallbackToolId = 0
      const subagentToolContext: ToolContext = {
        ...toolContext,
        toolCallId: undefined,
        onSubagentActivity: undefined,
        onToolCall: async (info) => {
          const existingIndex = findToolActivity(activity.tools, info.toolCallId, info.toolName)
          const now = Date.now()
          const next: SubagentToolActivity = existingIndex >= 0
            ? { ...activity.tools[existingIndex] }
            : {
                id: info.toolCallId ?? `tool-${++fallbackToolId}`,
                toolName: info.toolName,
                summary: summarizeToolInput(info.toolName, info.input),
                status: 'running',
                startedAt: now
              }
          next.status = info.status
          if (info.durationMs !== undefined) next.durationMs = info.durationMs
          if (info.status !== 'running') next.completedAt = now
          if (info.error) next.error = boundedText(info.error, 320)
          const tools = [...activity.tools]
          if (existingIndex >= 0) tools[existingIndex] = next
          else tools.push(next)
          await emit({
            phase: info.status === 'running' ? 'using-tool' : 'working',
            tools: tools.slice(-40)
          })
        }
      }

      const result = streamText({
        model: activeModel,
        instructions: 'You are a focused read-only sub-agent. Complete the given task and return a concise result. Do not ask questions. You may inspect the active workspace with the provided read-only tools, but you must not write files, run Bash, access external network, or use MCP. The active workspace is: ' + workspaceLabel,
        messages: [{
          role: 'user',
          content: extraContext ? `Workspace: ${workspaceLabel}\n\nContext:\n${extraContext}\n\nTask:\n${prompt}` : `Workspace: ${workspaceLabel}\n\nTask:\n${prompt}`
        }],
        tools: buildToolSet(READ_ONLY_SUBAGENT_TOOLS, subagentToolContext),
        stopWhen: isStepCount(maxSteps),
        abortSignal: toolContext.abortSignal,
        onStepStart: async ({ stepNumber }) => {
          await emit({ phase: 'working', currentStep: stepNumber + 1 })
        },
        onStepEnd: async (step) => {
          if (step.finishReason !== 'tool-calls') await emit({ phase: 'finalizing', currentStep: step.stepNumber + 1 })
        }
      })
      const [output, usage, steps] = await Promise.all([result.text, result.usage, result.steps])
      const normalizedUsage = streamUsageFromModelUsage(usage, steps.length)
      const completedAt = Date.now()
      await emit({
        status: 'completed',
        phase: 'completed',
        currentStep: steps.length,
        completedAt,
        outputPreview: boundedText(output, 2_000),
        usage: normalizedUsage
      })
      return { output, usage: normalizedUsage, activity: cloneActivity(activity) }
    }, toolContext.abortSignal)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const cancelled = toolContext.abortSignal?.aborted || /aborted/i.test(message)
    await emit({
      status: cancelled ? 'cancelled' : 'failed',
      phase: cancelled ? 'cancelled' : 'failed',
      completedAt: Date.now(),
      error: boundedText(message, 500)
    })
    throw error
  }
}

export const agentTool: ToolDefinition = {
  name: 'Agent',
  description:
    'Spawn a controlled read-only sub-agent for a focused task. It inherits workspace/session/approval and cancellation context, and only receives Read/Grep/Glob/GitStatus/GitDiff/GitLog/GitBranch. It cannot write files, run Bash, use external network, or access MCP. Max 4 concurrent; queued tasks are cancellable.',
  inputSchema: z.object({
    prompt: z.string().describe('The task description for the sub-agent'),
    context: z
      .string()
      .optional()
      .describe('Additional context to pass to the sub-agent')
  }),
  execute: async (input, toolContext: ToolContext): Promise<ToolResult> => {
    const { prompt, context: extraContext } = input as { prompt: string; context?: string }
    const result = await runSubagent({ prompt, context: extraContext, toolContext })
    return { output: result.output, metadata: { usage: result.usage, subagentActivity: result.activity } }
  }
}

export const subagentTools: ToolDefinition[] = [agentTool]

function findToolActivity(tools: SubagentToolActivity[], toolCallId: string | undefined, toolName: string): number {
  if (toolCallId) {
    const exact = tools.findIndex((tool) => tool.id === toolCallId)
    if (exact >= 0) return exact
  }
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    if (tools[index].toolName === toolName && tools[index].status === 'running') return index
  }
  return -1
}

function summarizeToolInput(toolName: string, input: Record<string, unknown>): string | undefined {
  const value = toolName === 'Read'
    ? input.filePath
    : toolName === 'Grep'
      ? [input.pattern, input.path].filter((item) => typeof item === 'string').join(' · ')
      : toolName === 'Glob'
        ? [input.pattern, input.path].filter((item) => typeof item === 'string').join(' · ')
        : toolName === 'GitDiff'
          ? input.staged === true ? 'staged' : 'working tree'
          : toolName === 'GitLog'
            ? `limit ${typeof input.limit === 'number' ? input.limit : 10}`
            : toolName === 'GitBranch'
              ? input.all === true ? 'all branches' : 'local branches'
              : undefined
  return typeof value === 'string' && value.trim() ? boundedText(value, 180) : undefined
}

function boundedText(value: string, limit: number): string {
  const normalized = value.trim()
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}…`
}

function cloneActivity(activity: SubagentActivity): SubagentActivity {
  return {
    ...activity,
    tools: activity.tools.map((tool) => ({ ...tool })),
    ...(activity.usage ? { usage: { ...activity.usage } } : {})
  }
}

async function safeEmitActivity(context: ToolContext, activity: SubagentActivity): Promise<void> {
  try {
    await context.onSubagentActivity?.(activity)
  } catch {
    // Observability must never change sub-agent execution.
  }
}
