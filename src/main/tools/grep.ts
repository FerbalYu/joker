import { z } from 'zod'
import { readdir, stat, lstat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { existsSync } from 'node:fs'
import type { ToolDefinition, ToolResult, ToolContext } from './registry'
import { resolveWorkspacePath } from '../store/projects'

function requireWorkspace(workspacePath: string | null): string {
  if (!workspacePath) throw new Error('No working folder selected for this conversation.')
  return workspacePath
}

function safePath(workspacePath: string | null, filePath: string): string {
  const root = requireWorkspace(workspacePath)
  return resolveWorkspacePath(root, filePath)
}

async function searchDirectory(
  dir: string,
  pattern: string,
  options: GrepOptions,
  results: string[],
  maxResults: number
): Promise<void> {
  if (results.length >= maxResults) return

  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (results.length >= maxResults) return

    // Skip common ignored directories
    if (entry.isDirectory() && shouldIgnore(entry.name)) continue

    const fullPath = join(dir, entry.name)
    const entryStat = await lstat(fullPath)
    if (entryStat.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      await searchDirectory(fullPath, pattern, options, results, maxResults)
    } else if (entry.isFile()) {
      const matched = await searchFile(fullPath, pattern, options)
      results.push(...matched)
      if (results.length >= maxResults) return
    }
  }
}

function shouldIgnore(name: string): boolean {
  const ignoreList = ['node_modules', '.git', 'dist', 'out', '.next', '__pycache__', '.venv']
  return ignoreList.includes(name) || name.startsWith('.')
}

interface GrepOptions {
  caseSensitive: boolean
  maxResults: number
  contextLines: number
}

async function searchFile(
  filePath: string,
  pattern: string,
  options: GrepOptions
): Promise<string[]> {
  const { readFile } = await import('node:fs/promises')
  let content: string
  try {
    content = await readFile(filePath, 'utf-8')
  } catch {
    return []
  }

  const lines = content.split('\n')
  const matches: string[] = []
  const regex = options.caseSensitive
    ? new RegExp(pattern)
    : new RegExp(pattern, 'i')

  for (let i = 0; i < lines.length; i++) {
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

    const searchPath = safePath(context.workspacePath, path)
    if (!existsSync(searchPath)) {
      return { output: `Path not found: ${path}` }
    }

    const options: GrepOptions = { caseSensitive, maxResults, contextLines }
    const results: string[] = []

    const stats = await stat(searchPath)
    if (stats.isDirectory()) {
      await searchDirectory(searchPath, pattern, options, results, maxResults)
    } else {
      const matched = await searchFile(searchPath, pattern, options)
      results.push(...matched)
    }

    if (results.length === 0) {
      return { output: 'No matches found.' }
    }

    const truncated = results.length >= maxResults ? `\n... (truncated at ${maxResults} results)` : ''
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

    // Simple glob: convert ** to recursive walk, * to single-level
    const { glob } = await import('node:fs/promises')
    const matches: string[] = []

    async function walk(dir: string, remaining: string[]): Promise<void> {
      if (matches.length > 200) return
      if (remaining.length === 0) {
        matches.push(relative(workspaceRoot, dir))
        return
      }
      const [seg, ...rest] = remaining
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
        const fullPath = join(dir, entry.name)
        if (seg === '**') {
          if (entry.isDirectory()) {
            await walk(fullPath, remaining) // ** matches zero
            await walk(fullPath, ['**', ...rest]) // ** matches more
          }
        } else if (seg.includes('*')) {
          const regex = new RegExp('^' + seg.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$')
          if (regex.test(entry.name)) {
            if (rest.length === 0 && entry.isFile()) {
              matches.push(relative(workspaceRoot, fullPath))
            } else if (entry.isDirectory()) {
              await walk(fullPath, rest)
            }
          }
        } else if (entry.name === seg) {
          if (rest.length === 0 && entry.isFile()) {
            matches.push(relative(workspaceRoot, fullPath))
          } else if (entry.isDirectory()) {
            await walk(fullPath, rest)
          }
        }
      }
    }

    const segments = pattern.split('/')
    await walk(basePath, segments)

    void glob // suppress unused
    return { output: matches.length > 0 ? matches.join('\n') : 'No files found.' }
  }
}

export const searchTools: ToolDefinition[] = [grepTool, globTool]
