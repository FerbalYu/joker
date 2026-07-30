export type ToolRisk = 'read' | 'write_local' | 'exec' | 'external'

const BUILTIN_RISKS: Record<string, ToolRisk> = {
  Read: 'read',
  ContextRetrieve: 'read',
  Grep: 'read',
  Glob: 'read',
  TodoWrite: 'read',
  GitStatus: 'read',
  GitDiff: 'read',
  GitLog: 'read',
  GitBranch: 'read',
  PresentResearchReport: 'read',
  Write: 'write_local',
  Edit: 'write_local',
  Bash: 'exec',
  Agent: 'external',
  WebSearch: 'external',
  WebRead: 'external',
  GenerateImage: 'external'
}

export function classifyToolRisk(
  toolName: string,
  declaredRisk?: ToolRisk,
  source?: { type: 'builtin' | 'mcp' }
): ToolRisk {
  if (declaredRisk) return declaredRisk
  if (source?.type === 'mcp') return 'external'
  return BUILTIN_RISKS[toolName] ?? 'external'
}
