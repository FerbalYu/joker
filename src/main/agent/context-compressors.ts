import type { ContextTransformMetric } from '../../shared/context'

export interface ToolCompressionInput {
  toolName: string
  content: string
  maxTokens: number
  contextId?: string
}

export interface ToolCompressionResult {
  content: string
  transform: ContextTransformMetric
  omitted: string
}

export type ToolCompressor = (input: ToolCompressionInput) => ToolCompressionResult | null

const ERROR_LINE = /\b(error|failed|failure|exception|fatal|panic|denied|conflict|warning|warn)\b/i
const MAX_REPRESENTATIVE_LINES = 24

export class ToolCompressorRegistry {
  private readonly exact = new Map<string, ToolCompressor>()
  private readonly detectors: ToolCompressor[] = []

  registerTool(toolNames: string[], compressor: ToolCompressor): this {
    for (const name of toolNames) this.exact.set(name.toLocaleLowerCase(), compressor)
    return this
  }

  registerDetector(compressor: ToolCompressor): this {
    this.detectors.push(compressor)
    return this
  }

  compress(input: ToolCompressionInput): ToolCompressionResult {
    const startedAt = Date.now()
    const compressor = this.exact.get(input.toolName.toLocaleLowerCase())
    const result = compressor?.(input) ?? this.detectors.map((candidate) => candidate(input)).find(Boolean) ?? genericCompressor(input)
    const safe = result && tokens(result.content) < tokens(input.content) ? result : fallbackCompressor(input)
    safe.transform.durationMs = Date.now() - startedAt
    return safe
  }
}

export const defaultToolCompressorRegistry = new ToolCompressorRegistry()
  .registerTool(['GitDiff'], gitDiffCompressor)
  .registerTool(['Grep', 'Glob', 'WebSearch'], searchCompressor)
  .registerTool(['Bash'], logCompressor)
  .registerTool(['Read', 'WebRead'], readCompressor)
  .registerTool(['Agent'], agentCompressor)
  .registerTool(['TodoWrite'], todoCompressor)
  .registerDetector(jsonCompressor)
  .registerDetector(logCompressor)

function result(input: ToolCompressionInput, content: string, transform: string, omitted: string): ToolCompressionResult {
  return {
    content: decorate(input, content, omitted),
    omitted,
    transform: {
      sourceType: input.toolName || 'tool-result',
      transform,
      beforeTokens: tokens(input.content),
      afterTokens: tokens(content),
      durationMs: 0,
      contextId: input.contextId,
      retrievable: Boolean(input.contextId)
    }
  }
}

function decorate(input: ToolCompressionInput, content: string, omitted: string): string {
  const reference = input.contextId
    ? `\n[Context compressed]\ncontextId: ${input.contextId}\nsource: ${input.toolName}\noriginalTokens: ${tokens(input.content)}\nomitted: ${omitted}\nUse ContextRetrieve when exact omitted details are required.\n`
    : '\n[Context compressed; original remains in the session]\n'
  return `${content.trimEnd()}${reference}`
}

function jsonCompressor(input: ToolCompressionInput): ToolCompressionResult | null {
  const trimmed = input.content.trim()
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return null
  try {
    const value = JSON.parse(trimmed) as unknown
    const compact = JSON.stringify(value)
    if (tokens(compact) <= input.maxTokens) return result(input, compact, 'json-minify', 'whitespace')
    const protectedValues = collectJsonHighlights(value)
    const summary = JSON.stringify({
      type: Array.isArray(value) ? 'array' : 'object',
      count: Array.isArray(value) ? value.length : Object.keys(value as Record<string, unknown>).length,
      highlights: protectedValues.slice(0, 40),
      sample: Array.isArray(value) ? [...value.slice(0, 3), ...value.slice(-2)] : value
    })
    return result(input, limit(summary, input.maxTokens), 'json-structure-sample', 'repeated objects and low-priority fields')
  } catch {
    return null
  }
}

function collectJsonHighlights(value: unknown, path = '$', highlights: string[] = []): string[] {
  if (highlights.length >= 80) return highlights
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectJsonHighlights(item, `${path}[${index}]`, highlights))
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (/^(id|status|error|errors|message|code|url|path|name)$/i.test(key)) highlights.push(`${path}.${key}=${JSON.stringify(item)}`)
      collectJsonHighlights(item, `${path}.${key}`, highlights)
    }
  }
  return highlights
}

function logCompressor(input: ToolCompressionInput): ToolCompressionResult | null {
  const lines = input.content.split(/\r?\n/)
  if (lines.length < 12 && !ERROR_LINE.test(input.content)) return null
  const counts = new Map<string, { line: string; count: number }>()
  for (const line of lines) {
    const template = line.replace(/\b\d+(?:\.\d+)?\b/g, '#').replace(/0x[0-9a-f]+/gi, '0x#')
    const current = counts.get(template)
    if (current) current.count += 1
    else counts.set(template, { line, count: 1 })
  }
  const errors = lines.filter((line) => ERROR_LINE.test(line)).slice(0, MAX_REPRESENTATIVE_LINES)
  const repeated = [...counts.values()].filter((entry) => entry.count > 1).sort((a, b) => b.count - a.count).slice(0, 16)
  const content = [
    `Log lines: ${lines.length}`,
    ...lines.slice(0, 6),
    ...(errors.length ? ['[errors/warnings]', ...errors] : []),
    ...(repeated.length ? ['[repeated templates]', ...repeated.map((entry) => `${entry.count}x ${entry.line}`)] : []),
    '[tail]',
    ...lines.slice(-8)
  ].join('\n')
  return result(input, limit(content, input.maxTokens), 'log-template-fold', 'duplicate and routine log lines')
}

function searchCompressor(input: ToolCompressionInput): ToolCompressionResult | null {
  const lines = input.content.split(/\r?\n/).filter(Boolean)
  if (lines.length < 10) return null
  const groups = new Map<string, string[]>()
  for (const line of lines) {
    const key = line.match(/^(https?:\/\/[^/\s]+|[^:\s]+(?:[\\/][^:\s]+)+)/)?.[1] ?? 'other'
    const group = groups.get(key) ?? []
    if (group.length < 6 || ERROR_LINE.test(line)) group.push(line)
    groups.set(key, group)
  }
  const content = [`Search results: ${lines.length} lines across ${groups.size} groups`]
  for (const [key, entries] of groups) content.push(`[${key}]`, ...entries)
  return result(input, limit(content.join('\n'), input.maxTokens), 'search-group-sample', 'duplicate and excess matches per file/source')
}

function gitDiffCompressor(input: ToolCompressionInput): ToolCompressionResult | null {
  if (!/^(diff --git|--- |\+\+\+ |@@ )/m.test(input.content)) return null
  const lines = input.content.split(/\r?\n/)
  const kept: string[] = []
  let hunkLines = 0
  for (const line of lines) {
    if (/^(diff --git|index |--- |\+\+\+ |@@ |<<<<<<<|=======|>>>>>>>)/.test(line)) {
      kept.push(line)
      hunkLines = 0
    } else if (/^[+-]/.test(line) || ERROR_LINE.test(line)) {
      if (hunkLines < 80) kept.push(line)
      hunkLines += 1
    }
  }
  return result(input, limit(kept.join('\n'), input.maxTokens), 'git-diff-hunks', 'unchanged context and excess hunk lines')
}

function readCompressor(input: ToolCompressionInput): ToolCompressionResult | null {
  const lines = input.content.split(/\r?\n/)
  if (tokens(input.content) <= input.maxTokens) return null
  const protectedLines = lines.filter((line) => ERROR_LINE.test(line) || /^(\s*(import|export|class|interface|type|function)|\s*#{1,6}\s|\s*\d+\s*[|:\t])/.test(line))
  const content = [...lines.slice(0, 40), '[protected definitions/headings]', ...protectedLines.slice(0, 100), '[tail]', ...lines.slice(-30)].join('\n')
  return result(input, limit(content, input.maxTokens), input.toolName === 'WebRead' ? 'web-read-outline' : 'read-symbol-sample', 'middle prose or file lines outside protected definitions')
}

function agentCompressor(input: ToolCompressionInput): ToolCompressionResult | null {
  if (tokens(input.content) <= input.maxTokens) return null
  const lines = input.content.split(/\r?\n/)
  const findings = lines.filter((line) => ERROR_LINE.test(line) || /\b(todo|open|remaining|finding|decision|evidence|file|test|failed|blocked)\b/i.test(line))
  return result(input, limit([...lines.slice(0, 20), '[findings/open work]', ...findings.slice(0, 100), '[conclusion]', ...lines.slice(-20)].join('\n'), input.maxTokens), 'agent-report-structure', 'low-signal narrative')
}

function todoCompressor(input: ToolCompressionInput): ToolCompressionResult | null {
  try {
    const parsed = JSON.parse(input.content) as unknown
    const todos = Array.isArray(parsed) ? parsed : (parsed as { todos?: unknown[] })?.todos
    if (!Array.isArray(todos)) return null
    const latest = todos.filter((todo) => todo && typeof todo === 'object')
    return result(input, limit(JSON.stringify(latest), input.maxTokens), 'todo-latest-snapshot', 'older todo snapshots')
  } catch {
    return null
  }
}

function genericCompressor(input: ToolCompressionInput): ToolCompressionResult | null {
  if (tokens(input.content) <= input.maxTokens) return null
  return result(input, headTail(input.content, input.maxTokens), 'generic-head-tail', 'middle content')
}

function fallbackCompressor(input: ToolCompressionInput): ToolCompressionResult {
  const projected = tokens(input.content) <= input.maxTokens ? input.content : headTail(input.content, input.maxTokens)
  return result(input, projected, projected === input.content ? 'none' : 'safe-head-tail', projected === input.content ? 'nothing' : 'middle content')
}

function headTail(content: string, maxTokens: number): string {
  const maxChars = Math.max(0, maxTokens * 4)
  const marker = '\n[content omitted]\n'
  if (content.length <= maxChars) return content
  const remaining = Math.max(0, maxChars - marker.length)
  const head = Math.floor(remaining * 0.7)
  return `${content.slice(0, head)}${marker}${content.slice(-(remaining - head))}`
}

function limit(content: string, maxTokens: number): string {
  return tokens(content) <= maxTokens ? content : headTail(content, maxTokens)
}

function tokens(content: string): number {
  return Math.max(1, Math.ceil(content.length / 4))
}
