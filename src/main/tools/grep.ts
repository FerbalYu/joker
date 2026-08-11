import { z } from 'zod'
import { readdir, stat, lstat, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { existsSync } from 'node:fs'
import type { ToolDefinition, ToolResult, ToolContext } from './registry'
import { resolveWorkspacePath } from '../store/projects'

const MAX_GREP_RESULTS = 500
const MAX_GLOB_RESULTS = 200

function requireWorkspace(workspacePath: string | null): string {
  if (!workspacePath) throw new Error('No working folder selected for this conversation.')
  return workspacePath
}

function safePath(workspacePath: string | null, filePath: string): string {
  const root = requireWorkspace(workspacePath)
  return resolveWorkspacePath(root, filePath)
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new Error('Search cancelled')
}

async function searchDirectory(
  dir: string,
  regex: RegExp,
  options: GrepOptions,
  results: string[],
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal)
  if (results.length >= options.maxResults) return

  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    throwIfAborted(signal)
    if (results.length >= options.maxResults) return
    if (entry.isDirectory() && shouldIgnore(entry.name)) continue

    const fullPath = join(dir, entry.name)
    const entryStat = await lstat(fullPath)
    if (entryStat.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      await searchDirectory(fullPath, regex, options, results, signal)
    } else if (entry.isFile()) {
      const matched = await searchFile(fullPath, regex, options, signal)
      results.push(...matched.slice(0, options.maxResults - results.length))
    }
  }
}

function shouldIgnore(name: string): boolean {
  const ignoreList = ['node_modules', '.git', 'dist', 'out', '.next', '__pycache__', '.venv']
  return ignoreList.includes(name) || name.startsWith('.')
}

interface GrepOptions {
  maxResults: number
  contextLines: number
}

async function searchFile(
  filePath: string,
  regex: RegExp,
  options: GrepOptions,
  signal?: AbortSignal
): Promise<string[]> {
  throwIfAborted(signal)
  let content: string
  try {
    content = await readFile(filePath, 'utf-8')
  } catch {
    return []
  }

  const lines = content.split('\n')
  const matches: string[] = []
  for (let i = 0; i < lines.length; i++) {
    throwIfAborted(signal)
    regex.lastIndex = 0
    if (regex.test(lines[i]!)) {
      const start = Math.max(0, i - options.contextLines)
      const end = Math.min(lines.length - 1, i + options.contextLines)
      const context = lines
        .slice(start, end + 1)
        .map((line, idx) => {
          const lineNum = start + idx + 1
          const marker = start + idx === i ? '>' : ' '
          return `${marker} ${String(lineNum).padStart(6)}\t${line}`
        })
        .join('\n')
      matches.push(`${filePath}:\n${context}`)
      if (matches.length >= options.maxResults) break
    }
  }
  return matches
}

export const grepTool: ToolDefinition = {
  name: 'Grep',
  description:
    'Search for a regex pattern across files in the workspace. Returns matching lines with file paths and optional context.',
  inputSchema: z.object({
    pattern: z.string().describe('Regular expression pattern to search for'),
    path: z.string().optional().describe('Directory or file to search in (default: workspace root)'),
    caseSensitive: z.boolean().optional().describe('Case sensitive search (default true)'),
    maxResults: z.number().optional().describe('Maximum number of matches (default 50)'),
    contextLines: z.number().optional().describe('Lines of context around matches (default 2)')
  }),
  execute: async (input, context: ToolContext): Promise<ToolResult> => {
    const {
      pattern,
      path = '.',
      caseSensitive = true,
      maxResults = 50,
      contextLines = 2
    } = input as {
      pattern: string
      path?: string
      caseSensitive?: boolean
      maxResults?: number
      contextLines?: number
    }

    throwIfAborted(context.abortSignal)
    const searchPath = safePath(context.workspacePath, path)
    if (!existsSync(searchPath)) return { output: `Path not found: ${path}` }

    const options: GrepOptions = {
      maxResults: Math.max(1, Math.min(MAX_GREP_RESULTS, Math.floor(maxResults))),
      contextLines: Math.max(0, Math.min(20, Math.floor(contextLines)))
    }
    const regex = new RegExp(pattern, caseSensitive ? '' : 'i')
    const results: string[] = []
    const stats = await stat(searchPath)
    if (stats.isDirectory()) {
      await searchDirectory(searchPath, regex, options, results, context.abortSignal)
    } else {
      const matched = await searchFile(searchPath, regex, options, context.abortSignal)
      results.push(...matched.slice(0, options.maxResults))
    }

    if (results.length === 0) return { output: 'No matches found.' }
    const truncated = results.length >= options.maxResults ? `\n... (truncated at ${options.maxResults} results)` : ''
    return { output: results.join('\n\n') + truncated }
  }
}

export const globTool: ToolDefinition = {
  name: 'Glob',
  description: 'Find files matching a glob pattern. Returns matching file paths.',
  inputSchema: z.object({
    pattern: z.string().describe('Glob pattern (e.g. "**/*.ts", "src/**/*.json")'),
    path: z.string().optional().describe('Base directory (default: workspace root)')
  }),
  execute: async (input, context: ToolContext): Promise<ToolResult> => {
    const { pattern, path = '.' } = input as { pattern: string; path?: string }
    const basePath = safePath(context.workspacePath, path)
    const workspaceRoot = requireWorkspace(context.workspacePath)
    const matches = new Set<string>()

    async function walk(dir: string, remaining: string[]): Promise<void> {
      throwIfAborted(context.abortSignal)
      if (matches.size >= MAX_GLOB_RESULTS || remaining.length === 0) return
      const [seg, ...rest] = remaining

      if (seg === '**') {
        if (rest.length > 0) await walk(dir, rest)
        const entries = await readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          throwIfAborted(context.abortSignal)
          if (matches.size >= MAX_GLOB_RESULTS) return
          if (shouldIgnore(entry.name)) continue
          const fullPath = join(dir, entry.name)
          const entryStat = await lstat(fullPath)
          if (entryStat.isSymbolicLink()) continue
          if (entry.isDirectory()) await walk(fullPath, remaining)
          else if (entry.isFile() && rest.length === 0) matches.add(relative(workspaceRoot, fullPath).replaceAll('\\', '/'))
        }
        return
      }

      const regex = segmentRegex(seg)
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        throwIfAborted(context.abortSignal)
        if (matches.size >= MAX_GLOB_RESULTS) return
        if (shouldIgnore(entry.name) || !regex.test(entry.name)) continue
        const fullPath = join(dir, entry.name)
        const entryStat = await lstat(fullPath)
        if (entryStat.isSymbolicLink()) continue
        if (rest.length === 0 && entry.isFile()) matches.add(relative(workspaceRoot, fullPath).replaceAll('\\', '/'))
        else if (entry.isDirectory()) await walk(fullPath, rest)
      }
    }

    const segments = pattern.replaceAll('\\', '/').split('/').filter(Boolean)
    await walk(basePath, segments)
    return { output: matches.size > 0 ? [...matches].join('\n') : 'No files found.' }
  }
}

function segmentRegex(segment: string): RegExp {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}

export const searchTools: ToolDefinition[] = [grepTool, globTool]
