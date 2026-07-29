import { z } from 'zod'
import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import type { ToolDefinition, ToolResult, ToolContext } from './registry'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 1024 * 1024
const OUTPUT_TRUNCATION_MARKER = '\n[output truncated: 1 MiB limit]'

function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    child.kill()
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

function appendBounded(current: string, chunk: Buffer | string): { value: string; truncated: boolean } {
  const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
  const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(current, 'utf8')
  if (remaining <= 0) return { value: current, truncated: true }
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.byteLength <= remaining) return { value: current + text, truncated: false }
  return { value: current + bytes.subarray(0, remaining).toString('utf8'), truncated: true }
}

function formatOutput(stdout: string, stderr: string, exitCode: number | null, reason?: 'timeout' | 'aborted'): string {
  let output = ''
  if (stdout.trim()) output += stdout.trim()
  if (stderr.trim()) output += (output ? '\n' : '') + `[stderr] ${stderr.trim()}`
  if (reason === 'timeout') output += (output ? '\n' : '') + '[timed out]'
  if (reason === 'aborted') output += (output ? '\n' : '') + '[aborted]'
  if (reason === undefined && exitCode !== 0) output += (output ? '\n' : '') + `[exit code: ${exitCode ?? 1}]`
  return output || `[completed with exit code ${exitCode ?? 1}]`
}

export const bashTool: ToolDefinition = {
  name: 'Bash',
  description:
    'Execute a shell command and return stdout/stderr. Commands run in the workspace directory.',
  inputSchema: z.object({
    command: z.string().describe('The shell command to execute'),
    timeout: z
      .number()
      .int()
      .min(1)
      .max(10 * 60 * 1000)
      .optional()
      .describe('Timeout in milliseconds (default 120000)')
  }),
  execute: async (input, context: ToolContext): Promise<ToolResult> => {
    const { command, timeout = DEFAULT_TIMEOUT_MS } = input as { command: string; timeout?: number }
    if (!context.workspacePath) return { output: 'No working folder selected for this conversation.' }
    const cwd = resolve(context.workspacePath)

    return new Promise((resolveResult) => {
      let stdout = ''
      let stderr = ''
      let outputTruncated = false
      let reason: 'timeout' | 'aborted' | undefined
      let settled = false
      let timer: NodeJS.Timeout | undefined

      const child = spawn(command, {
        shell: true,
        cwd,
        env: { ...process.env },
        windowsHide: true,
        detached: process.platform !== 'win32'
      })

      const terminate = (terminationReason: 'timeout' | 'aborted'): void => {
        if (settled || reason) return
        reason = terminationReason
        killProcessTree(child)
      }

      const onAbort = (): void => terminate('aborted')
      if (context.abortSignal?.aborted) terminate('aborted')
      else context.abortSignal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => terminate('timeout'), timeout)

      child.stdout?.on('data', (data: Buffer) => {
        const result = appendBounded(stdout, data)
        stdout = result.value
        outputTruncated ||= result.truncated
      })
      child.stderr?.on('data', (data: Buffer) => {
        const result = appendBounded(stderr, data)
        stderr = result.value
        outputTruncated ||= result.truncated
      })

      child.on('close', (code) => {
        if (timer) clearTimeout(timer)
        context.abortSignal?.removeEventListener('abort', onAbort)
        settled = true
        const output = formatOutput(stdout, stderr, code, reason)
        resolveResult({ output: outputTruncated ? `${output}${OUTPUT_TRUNCATION_MARKER}` : output, metadata: { truncated: outputTruncated, reason } })
      })

      child.on('error', (err) => {
        if (timer) clearTimeout(timer)
        context.abortSignal?.removeEventListener('abort', onAbort)
        settled = true
        resolveResult({ output: `Error executing command: ${err.message}`, metadata: { truncated: outputTruncated, reason } })
      })
    })
  }
}

export const bashTools: ToolDefinition[] = [bashTool]
