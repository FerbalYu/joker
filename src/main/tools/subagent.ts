import { isStepCount, streamText } from 'ai'
import { createLanguageModel } from '../providers'
import { loadConfig, resolveActiveModel } from '../store/config'
import { z } from 'zod'
import { buildToolSet, type ToolDefinition, type ToolResult, type ToolContext } from './registry'
import { readTool } from './fs'
import { grepTool, globTool } from './grep'
import { gitTools } from './git'

// Concurrency limiter — max 4 concurrent sub-agents.
const MAX_CONCURRENT_SUBAGENTS = 4
let runningSubagents = 0
const queuedSubagents: Array<{
  run: () => Promise<string>
  resolve: (value: string | PromiseLike<string>) => void
  reject: (reason?: unknown) => void
  signal?: AbortSignal
  onAbort?: () => void
}> = []

function abortError(): Error {
  return new Error('Aborted')
}

function runQueuedSubagent(run: () => Promise<string>, signal?: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const task: {
      run: () => Promise<string>
      resolve: (value: string | PromiseLike<string>) => void
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

const READ_ONLY_SUBAGENT_TOOLS: ToolDefinition[] = [readTool, grepTool, globTool, ...gitTools]

export function getReadonlySubagentToolNames(): string[] {
  return READ_ONLY_SUBAGENT_TOOLS.map((tool) => tool.name)
}

export interface SubagentRunOptions {
  prompt: string
  context?: string
  toolContext: ToolContext
  model?: ReturnType<typeof createLanguageModel>
}

export async function runSubagent({ prompt, context: extraContext, toolContext, model }: SubagentRunOptions): Promise<string> {
  if (toolContext.abortSignal?.aborted) throw new Error('Aborted')
  return runQueuedSubagent(async () => {
    if (toolContext.abortSignal?.aborted) throw new Error('Aborted')
    const activeModel = model ?? createLanguageModel(resolveActiveModel(loadConfig()))
    const workspaceLabel = toolContext.workspacePath ?? 'none (no working folder selected)'

    const result = streamText({
      model: activeModel,
      instructions: 'You are a focused read-only sub-agent. Complete the given task and return a concise result. Do not ask questions. You may inspect the active workspace with the provided read-only tools, but you must not write files, run Bash, access external network, or use MCP. The active workspace is: ' + workspaceLabel,
      messages: [{
        role: 'user',
        content: extraContext ? `Workspace: ${workspaceLabel}\n\nContext:\n${extraContext}\n\nTask:\n${prompt}` : `Workspace: ${workspaceLabel}\n\nTask:\n${prompt}`
      }],
      tools: buildToolSet(READ_ONLY_SUBAGENT_TOOLS, toolContext),
      stopWhen: isStepCount(20),
      abortSignal: toolContext.abortSignal
    })
    return await result.text
  }, toolContext.abortSignal)
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
    return { output: result }
  }
}

export const subagentTools: ToolDefinition[] = [agentTool]
