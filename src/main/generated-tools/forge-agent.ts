import { isStepCount, streamText, type LanguageModel } from 'ai'

import { streamUsageFromModelUsage } from '../agent/usage'
import { createLanguageModel } from '../providers'
import { loadConfig, resolveActiveModel } from '../store/config'
import { buildToolSet, type ToolContext } from '../tools/registry'
import { buildForgeAgentTools, type BuildForgeAgentToolsOptions } from './forge-tools'

const MAX_FORGE_AGENT_STEPS = 20

export interface ForgeAgentRunOptions extends BuildForgeAgentToolsOptions {
  prompt: string
  toolContext: ToolContext
  model?: LanguageModel
  maxSteps?: number
}

export interface ForgeAgentRunResult {
  output: string
  usage: ReturnType<typeof streamUsageFromModelUsage>
  steps: number
}

export async function runForgeAgent(options: ForgeAgentRunOptions): Promise<ForgeAgentRunResult> {
  if (options.toolContext.abortSignal?.aborted) throw new Error('Aborted')
  const maxSteps = Math.min(Math.max(options.maxSteps ?? MAX_FORGE_AGENT_STEPS, 1), MAX_FORGE_AGENT_STEPS)
  const model = options.model ?? createLanguageModel(resolveActiveModel(loadConfig()))
  const tools = buildForgeAgentTools(options)
  const forgeContext: ToolContext = {
    ...options.toolContext,
    workspacePath: null,
    toolCallId: undefined,
    onSubagentActivity: undefined,
    approvalGate: async () => ({ outcome: 'allow', risk: 'write_local', reason: 'host-confined ForgeAgent tool' })
  }
  const result = streamText({
    model,
    instructions: [
      'You are the dedicated ToolForge manufacturing agent.',
      'You may operate only through the provided Forge* tools in the current job-scoped workspace.',
      'You have no Bash, Git, network, MCP, environment, secret, Registry, Policy, Promote, or arbitrary workspace tools.',
      'Build only an ES2020 quickjs-wasm Generated Tool matching ForgeReadSpec.',
      'Use ForgeRunCheck before ForgeSubmitCandidate.',
      'Submission creates an immutable untrusted candidate only. Never claim validation, trust, promotion, activation, or completion of the original user task.'
    ].join(' '),
    messages: [{ role: 'user', content: options.prompt }],
    tools: buildToolSet(tools, forgeContext),
    stopWhen: isStepCount(maxSteps),
    abortSignal: options.toolContext.abortSignal
  })
  const [output, usage, steps] = await Promise.all([result.text, result.usage, result.steps])
  return { output, usage: streamUsageFromModelUsage(usage, steps.length), steps: steps.length }
}
