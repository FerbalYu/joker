import type { ChatIntent, RunMode } from '../../shared/types'

export type ExecutionTaskKind =
  | 'plan'
  | 'continuation'
  | 'tool-forge-continuation'
  | 'workspace-inspection'
  | 'workspace-validation'
  | 'workspace-change'
  | 'web-research'
  | 'git-publish'

export interface RequiredFirstToolBinding {
  toolName: string
  toolId: string
  versionId: string
  fingerprint: string
  validationReportId?: string
  pointerRevision?: number
  capabilityRevision: number
}

export interface AgentExecutionContract {
  taskKind: ExecutionTaskKind
  requireToolCall: true
  activeToolNames: string[]
  requiredFirstTool?: RequiredFirstToolBinding
  reason: string
}

export interface ResolveExecutionContractInput {
  userText: string
  runMode: RunMode
  intent?: ChatIntent
  workspacePath: string | null
  availableToolNames: readonly string[]
}

export const EXECUTION_CONTRACT_VIOLATION =
  'Execution contract violation: this request required a real tool call, but the model returned only text. No action was performed.'

const META_ONLY_TOOLS = new Set(['ContextRetrieve', 'TodoWrite', 'PresentResearchReport', 'Agent'])
const CONTINUATION_PATTERN = /^(?:请|麻烦)?\s*(?:继续(?:做|处理|执行|完成|验证|修复|下一步)?|进行下一步|下一步|开始吧|执行吧|做吧|按(?:这个|上述|上面(?:的)?)做|就这么做|完成它|补上|加上)[。！？!?.\s]*$/iu
const ENGLISH_CONTINUATION_PATTERN = /^(?:please\s+)?(?:continue|proceed|next(?:\s+step)?|do\s+it|go\s+ahead|finish\s+it)[.!?\s]*$/iu
const INSPECTION_PATTERN = /^(?:请|麻烦|帮我)?\s*(?:检查|查看|读取|审查|排查|调查|确认|核对|盘点|梳理|分析|搜索|查找|查询|检索)(?:一下|下)?/u
const ENGLISH_INSPECTION_PATTERN = /^(?:please\s+)?(?:check|inspect|read|review|investigate|audit|analy[sz]e|examine|search|look\s+up)\b/iu
const VALIDATION_PATTERN = /^(?:请|麻烦|帮我)?\s*(?:运行|执行)?\s*(?:测试|验证|回归|构建|编译|启动|运行|调试)(?:一下|下)?/u
const ENGLISH_VALIDATION_PATTERN = /^(?:please\s+)?(?:test|verify|validate|build|compile|run|start|debug)\b/iu
const CHANGE_PATTERN = /^(?:请|麻烦|帮我)?\s*(?:(?:把|将)\s*.+?\s*)?(?:修复|修改|编辑|实现|开发|编写|重构|更新|升级|安装|新增|添加|删除|移除|调整|改造|优化|提交|推送|发布|部署|补上|加上|补齐|补充)/u
const ENGLISH_CHANGE_PATTERN = /^(?:please\s+)?(?:fix|change|edit|implement|develop|write|refactor|update|upgrade|install|add|remove|delete|adjust|optimi[sz]e|commit|push|publish|deploy)\b/iu
const WEB_RESEARCH_PATTERN = /^(?:请|麻烦|帮我)?\s*(?:联网(?:搜索|查找|查询|检索)|(?:搜索|查找|查询|检索)(?:一下|下)?(?:网上|网络|网页|公开资料|最新公开信息))/u
const ENGLISH_WEB_RESEARCH_PATTERN = /^(?:please\s+)?(?:search|look\s+up|research)\s+(?:the\s+)?(?:web|internet|online|latest\s+public)\b/iu
const GIT_PUBLISH_PATTERN = /^(?:commit\s*\/\s*push|commit\s+push|commit\s+and\s+push|提交并推送)[。！？!?.\s]*$/iu

const TOOL_PREFERENCES: Record<ExecutionTaskKind, readonly string[]> = {
  plan: ['TodoWrite'],
  continuation: ['Bash', 'Read', 'Grep', 'Glob', 'GitStatus', 'GitDiff', 'Edit', 'Write'],
  'tool-forge-continuation': ['Bash', 'Read', 'Grep', 'Glob', 'GitStatus', 'GitDiff', 'Edit', 'Write'],
  'workspace-inspection': ['Read', 'Grep', 'Glob', 'GitStatus', 'GitDiff', 'GitLog', 'GitBranch', 'Bash'],
  'workspace-validation': ['Bash', 'Read', 'Grep', 'Glob', 'GitStatus', 'GitDiff'],
  'workspace-change': ['Read', 'Grep', 'Glob', 'GitStatus', 'GitDiff', 'Bash', 'Edit', 'Write'],
  'web-research': ['WebSearch', 'WebRead'],
  'git-publish': ['GitStatus', 'Bash']
}

export function resolveExecutionContract(input: ResolveExecutionContractInput): AgentExecutionContract | null {
  if (input.runMode === 'research') return null

  const available = new Set(input.availableToolNames)
  if (input.intent === 'plan') return buildContract('plan', available)

  const text = input.userText.trim()
  if (!text) return null

  if (WEB_RESEARCH_PATTERN.test(text) || ENGLISH_WEB_RESEARCH_PATTERN.test(text)) {
    return buildContract('web-research', available)
  }

  if (!input.workspacePath) return null

  if (GIT_PUBLISH_PATTERN.test(text)) {
    return buildContract('git-publish', available)
  }
  if (CONTINUATION_PATTERN.test(text) || ENGLISH_CONTINUATION_PATTERN.test(text)) {
    return buildContract('continuation', available)
  }
  if (VALIDATION_PATTERN.test(text) || ENGLISH_VALIDATION_PATTERN.test(text)) {
    return buildContract('workspace-validation', available)
  }
  if (CHANGE_PATTERN.test(text) || ENGLISH_CHANGE_PATTERN.test(text)) {
    return buildContract('workspace-change', available)
  }
  if (INSPECTION_PATTERN.test(text) || ENGLISH_INSPECTION_PATTERN.test(text)) {
    return buildContract('workspace-inspection', available)
  }
  return null
}

export function executionContractInstructions(contract: AgentExecutionContract): string {
  return [
    '<HOST_EXECUTION_CONTRACT>',
    `This turn is classified as ${contract.taskKind}.`,
    'Your first step must be a structured call to one of the tools provided for this step.',
    'Do not output a preamble, status summary, plan, or completion claim before the tool call.',
    'If the tool call fails or is denied, report that concrete result. Never claim work was performed without a tool result.',
    ...(contract.taskKind === 'git-publish' ? GIT_PUBLISH_INSTRUCTIONS : []),
    '</HOST_EXECUTION_CONTRACT>'
  ].join('\n')
}

const GIT_PUBLISH_INSTRUCTIONS = [
  'First step: inspect the working tree with git status. Do not commit or push before you know what changed.',
  'Protect unrelated dirty files; only stage and commit the target changes for this request.',
  'Report the actual number of commits created from the real git result, not an assumed count.',
  'Perform a real git push. Do not claim the remote was updated without a push result.',
  'Before claiming success, re-check git status and confirm the branch is in sync with its upstream.'
]

function buildContract(taskKind: ExecutionTaskKind, available: Set<string>): AgentExecutionContract | null {
  if (taskKind === 'git-publish') {
    const firstTool = available.has('GitStatus') ? 'GitStatus' : available.has('Bash') ? 'Bash' : null
    if (!firstTool) return null
    return {
      taskKind,
      requireToolCall: true,
      activeToolNames: [firstTool],
      requiredFirstTool: undefined,
      reason: 'short commit/push request; first step must inspect git status before any commit or push'
    }
  }
  const preferred = TOOL_PREFERENCES[taskKind].filter((name) => available.has(name))
  const fallback = [...available].filter((name) => !META_ONLY_TOOLS.has(name))
  const activeToolNames = preferred.length > 0 ? preferred : fallback
  if (activeToolNames.length === 0) return null
  return {
    taskKind,
    requireToolCall: true,
    activeToolNames,
    requiredFirstTool: undefined,
    reason: `tool-eligible ${taskKind} request`
  }
}
