import { mcpManager } from '../mcp/client'
import { readGeneratedToolRegistry } from '../generated-tools/registry'
import { listForgeJobs } from '../generated-tools/forge-job-store'
import { getJokerHomeDir } from '../store/paths'
import { readEffectiveRuntimeQualificationReport } from '../generated-tools/qualification'
import type { ToolDefinition } from './registry'

export type ToolSearchMatch = 'exact' | 'compatible' | 'building' | 'unavailable'

export interface ToolSearchResult {
  name: string
  source: 'builtin' | 'mcp' | 'generated' | 'forge-job'
  match: ToolSearchMatch
  description: string
  status?: string
  toolId?: string
  jobId?: string
}

export interface SearchToolsOptions {
  jokerHome?: string
  builtinTools?: readonly Pick<ToolDefinition, 'name' | 'description'>[]
}

function tokens(value: string): Set<string> {
  return new Set(value.toLocaleLowerCase('en-US').split(/[^a-z0-9]+/).filter((item) => item.length > 1))
}

function rank(query: string, name: string, description: string): 'exact' | 'compatible' | null {
  const folded = query.trim().toLocaleLowerCase('en-US')
  if (!folded) return null
  if (name.toLocaleLowerCase('en-US') === folded) return 'exact'
  const queryTokens = tokens(query)
  const textTokens = tokens(`${name} ${description}`)
  return [...queryTokens].some((item) => textTokens.has(item)) ? 'compatible' : null
}

export function searchTools(query: string, options: SearchToolsOptions = {}): ToolSearchResult[] {
  const jokerHome = options.jokerHome ?? getJokerHomeDir()
  const qualificationLevel = readEffectiveRuntimeQualificationReport(jokerHome)?.level ?? 'L0'
  const results: ToolSearchResult[] = []
  for (const tool of options.builtinTools ?? []) {
    const match = rank(query, tool.name, tool.description)
    if (match) results.push({ name: tool.name, source: 'builtin', match, description: tool.description })
  }
  for (const entry of mcpManager.getAllTools()) {
    const description = entry.tool.description ?? entry.tool.name
    const match = rank(query, entry.tool.name, description)
    if (match) results.push({ name: entry.tool.name, source: 'mcp', match, description, status: 'available' })
  }
  const registry = readGeneratedToolRegistry(jokerHome)
  for (const entry of registry.entries) {
    const descriptor = entry.descriptor
    const match = rank(query, descriptor.id, `${descriptor.displayName} ${descriptor.description}`)
    if (match) results.push({
      name: descriptor.displayName,
      source: 'generated',
      match: descriptor.availability === 'available' && qualificationLevel !== 'L0' ? match : 'unavailable',
      description: descriptor.description,
      status: descriptor.availability === 'available' && qualificationLevel === 'L0' ? 'runtime-qualification-required' : descriptor.availability,
      toolId: descriptor.id
    })
  }
  for (const job of listForgeJobs(jokerHome).jobs) {
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)) continue
    const match = rank(query, job.toolId, `${job.spec.displayName} ${job.spec.goal}`)
    if (match) results.push({
      name: job.spec.displayName,
      source: 'forge-job',
      match: 'building',
      description: job.spec.goal,
      status: job.status,
      toolId: job.toolId,
      jobId: job.id
    })
  }
  return results.sort((left, right) => {
    const order = { exact: 0, compatible: 1, building: 2, unavailable: 3 }
    return order[left.match] - order[right.match] || left.name.localeCompare(right.name, 'en-US')
  })
}
