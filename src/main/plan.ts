import type { ChatIntent } from '@shared/types'
import type { ToolDefinition } from './tools/registry'
import { contextTools } from './tools/context-retrieve'
import { fsTools } from './tools/fs'
import { searchTools } from './tools/grep'
import { todoTools } from './tools/todo'
import { gitTools } from './tools/git'
import { toolResultTools } from './tools/tool-result-read'

export const PLAN_TOOL_NAMES = ['ContextRetrieve', 'Read', 'Grep', 'Glob', 'TodoWrite', 'GitStatus', 'GitDiff', 'GitLog', 'ToolResultRead'] as const

export function normalizeChatIntent(value: unknown): ChatIntent | undefined {
  if (value === undefined) return undefined
  if (value === 'plan') return 'plan'
  throw new Error('Invalid chat intent')
}

export function buildPlanTools(): ToolDefinition[] {
  const definitions = new Map(
    [...contextTools, ...fsTools, ...searchTools, ...todoTools, ...gitTools, ...toolResultTools]
      .map((tool) => [tool.name, tool] as const)
  )
  return PLAN_TOOL_NAMES.map((name) => {
    const tool = definitions.get(name)
    if (!tool) throw new Error(`Missing plan tool definition: ${name}`)
    return tool
  })
}
