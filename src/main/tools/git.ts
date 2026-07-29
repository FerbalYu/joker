import { z } from 'zod'
import type { ToolContext, ToolDefinition, ToolResult } from './registry'
import { runReadonlyGit } from '../git/status'

const outputLimit = 40_000

function truncate(output: string): string {
  return output.length > outputLimit ? `${output.slice(0, outputLimit)}\n... [truncated]` : output
}

async function executeGit(args: string[], context: ToolContext): Promise<ToolResult> {
  if (!context.workspacePath) return { output: 'No working folder selected for this conversation.' }
  try {
    const output = await runReadonlyGit(args, context.workspacePath, context.abortSignal)
    return { output: truncate(output.trim() || '(no output)' ) }
  } catch (error) {
    if (context.abortSignal?.aborted) throw error
    return { output: error instanceof Error ? error.message : 'Git command failed' }
  }
}

const statusTool: ToolDefinition = {
  name: 'GitStatus',
  description: 'Show the current Git branch and working-tree status for the active workspace. Read-only.',
  inputSchema: z.object({}),
  execute: async (_input, context) => executeGit(['status', '--short', '--branch', '--untracked-files=normal'], context)
}

const diffTool: ToolDefinition = {
  name: 'GitDiff',
  description: 'Show a bounded Git diff for the active workspace. Read-only.',
  inputSchema: z.object({ staged: z.boolean().optional().describe('Show staged changes instead of working-tree changes') }),
  execute: async (input, context) => executeGit(['diff', ...(input.staged === true ? ['--cached'] : []), '--', '.'], context)
}

const logTool: ToolDefinition = {
  name: 'GitLog',
  description: 'Show recent Git commits for the active workspace. Read-only.',
  inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional() }),
  execute: async (input, context) => executeGit(['log', '--oneline', `-${input.limit ?? 10}`], context)
}

const branchTool: ToolDefinition = {
  name: 'GitBranch',
  description: 'List local and remote Git branches for the active workspace. Read-only.',
  inputSchema: z.object({ all: z.boolean().optional() }),
  execute: async (input, context) => executeGit(['branch', ...(input.all === true ? ['--all'] : [])], context)
}

export const gitTools: ToolDefinition[] = [statusTool, diffTool, logTool, branchTool]
