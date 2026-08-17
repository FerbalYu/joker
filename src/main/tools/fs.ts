import { z } from 'zod'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { diffLines, structuredPatch } from 'diff'
import type { ToolDefinition, ToolResult, ToolContext } from './registry'
import { resolveWorkspacePath } from '../store/projects'

function requireWorkspace(workspacePath: string | null): string {
  if (!workspacePath) throw new Error('No working folder selected for this conversation.')
  return workspacePath
}

function safePath(workspacePath: string | null, filePath: string, allowMissingTarget = false): string {
  const root = requireWorkspace(workspacePath)
  return resolveWorkspacePath(root, filePath, allowMissingTarget)
}

/** Content digest used as the optimistic-concurrency version for Read/Write/Edit. */
function contentVersion(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

const VERSION_DESCRIPTION = 'Optional version from the latest Read of this file. When provided, the file is only modified if its current content still matches this version; a mismatch means the file changed since it was read and the call fails instead of overwriting.'

function verifyVersionOrThrow(current: string, expectedVersion: string | undefined, filePath: string): void {
  if (expectedVersion === undefined) return
  if (contentVersion(current) !== expectedVersion) {
    throw new Error(`File changed since it was read (expectedVersion mismatch): ${filePath}. Re-read the file and retry.`)
  }
}

export const readTool: ToolDefinition = {
  name: 'Read',
  description:
    'Read the contents of a file. Returns the full text content with line numbers.',
  inputSchema: z.object({
    filePath: z.string().describe('Path to the file to read (absolute or relative to workspace)')
  }),
  execute: async (input, context: ToolContext): Promise<ToolResult> => {
    const { filePath } = input as { filePath: string }
    const absPath = safePath(context.workspacePath, filePath)
    const content = await readFile(absPath, 'utf-8')
    const lines = content.split('\n')
    const numbered = lines.map((line, i) => `${String(i + 1).padStart(6)}\t${line}`).join('\n')
    return { output: numbered, metadata: { version: contentVersion(content) } }
  }
}

export const writeTool: ToolDefinition = {
  name: 'Write',
  description:
    'Write content to a file. Creates parent directories if needed. Creates a new file if absent. Overwrites existing content; pass expectedVersion (from the latest Read) to fail instead when the file changed since it was read.',
  inputSchema: z.object({
    filePath: z.string().describe('Path to the file to write'),
    content: z.string().describe('Full content to write to the file'),
    expectedVersion: z.string().optional().describe(VERSION_DESCRIPTION)
  }),
  execute: async (input, context: ToolContext): Promise<ToolResult> => {
    const { filePath, content, expectedVersion } = input as { filePath: string; content: string; expectedVersion?: string }
    const absPath = safePath(context.workspacePath, filePath, true)
    const dir = dirname(absPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    if (existsSync(absPath)) {
      const current = await readFile(absPath, 'utf-8')
      verifyVersionOrThrow(current, expectedVersion, filePath)
    }
    await writeFile(absPath, content, 'utf-8')
    return { output: `File written: ${filePath}`, metadata: { version: contentVersion(content) } }
  }
}

export const editTool: ToolDefinition = {
  name: 'Edit',
  description:
    'Performs an exact string replacement in a file. The old_string must match exactly (including whitespace). Use replace_all to replace all occurrences.',
  inputSchema: z.object({
    filePath: z.string().describe('Path to the file to edit'),
    oldString: z.string().describe('The exact string to replace'),
    newString: z.string().describe('The replacement string'),
    replaceAll: z.boolean().optional().describe('Replace all occurrences (default false)'),
    expectedVersion: z.string().optional().describe(VERSION_DESCRIPTION)
  }),
  execute: async (input, context: ToolContext): Promise<ToolResult> => {
    const { filePath, oldString, newString, replaceAll, expectedVersion } = input as {
      filePath: string
      oldString: string
      newString: string
      replaceAll?: boolean
      expectedVersion?: string
    }
    const absPath = safePath(context.workspacePath, filePath)
    const original = await readFile(absPath, 'utf-8')
    verifyVersionOrThrow(original, expectedVersion, filePath)

    const occurrences = original.split(oldString).length - 1
    if (occurrences === 0) {
      throw new Error('old_string not found in file')
    }
    if (occurrences > 1 && !replaceAll) {
      throw new Error(`old_string appears ${occurrences} times. Provide replaceAll: true or use a more specific string.`)
    }

    const updated = replaceAll
      ? original.split(oldString).join(newString)
      : original.replace(oldString, newString)

    await writeFile(absPath, updated, 'utf-8')

    // Generate a diff
    const diff = diffLines(original, updated)
    let additions = 0
    let deletions = 0
    for (const part of diff) {
      if (part.added) additions += part.count
      if (part.removed) deletions += part.count
    }
    const patch = structuredPatch(filePath, filePath, original, updated, '', '', { context: 2 })
    const diffText = patch.hunks
      .map((hunk) => `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join('\n')}`)
      .join('\n')

    return {
      output: `Edited ${filePath}`,
      metadata: { diff: diffText, occurrences, additions, deletions, version: contentVersion(updated) }
    }
  }
}

export const fsTools: ToolDefinition[] = [readTool, writeTool, editTool]
