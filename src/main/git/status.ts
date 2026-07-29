import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import type { GitStatus } from '../../shared/types'

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 8_000
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024

function emptyStatus(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    isRepository: false,
    branch: null,
    detached: false,
    ahead: 0,
    behind: 0,
    changed: 0,
    untracked: 0,
    conflicted: 0,
    clean: true,
    available: true,
    ...overrides
  }
}

function safeError(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT') return 'Git is not installed'
  if (error && typeof error === 'object' && 'killed' in error && (error as { killed?: unknown }).killed === true) return 'Git status timed out'
  return 'Unable to read Git status'
}

export function parseGitStatus(output: string): GitStatus {
  let branch: string | null = null
  let detached = false
  let ahead = 0
  let behind = 0
  let changed = 0
  let untracked = 0
  let conflicted = 0

  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('# branch.head ')) {
      const value = line.slice('# branch.head '.length).trim()
      detached = value === '(detached)'
      branch = detached ? null : value || null
      continue
    }
    if (line.startsWith('# branch.ab ')) {
      const match = line.match(/^# branch\.ab \+(\d+) -(\d+)$/)
      if (match) {
        ahead = Number(match[1])
        behind = Number(match[2])
      }
      continue
    }
    if (line.startsWith('1 ') || line.startsWith('2 ')) {
      changed += 1
      continue
    }
    if (line.startsWith('u ')) {
      conflicted += 1
      changed += 1
      continue
    }
    if (line.startsWith('? ')) {
      untracked += 1
    }
  }

  return {
    isRepository: true,
    branch,
    detached,
    ahead,
    behind,
    changed,
    untracked,
    conflicted,
    clean: changed === 0 && untracked === 0 && conflicted === 0,
    available: true
  }
}

async function runGit(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new Error('Aborted')
  const result = await execFileAsync('git', ['-C', resolve(cwd), ...args], {
    cwd: resolve(cwd),
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true,
    signal
  })
  return result.stdout
}

export async function detectGitStatus(workspacePath: string | null, signal?: AbortSignal): Promise<GitStatus> {
  if (!workspacePath) return emptyStatus()
  try {
    await runGit(['rev-parse', '--show-toplevel'], workspacePath, signal)
  } catch (error) {
    const message = error instanceof Error && error.message === 'Aborted' ? 'Git status stopped' : safeError(error)
    if (message === 'Git is not installed') return emptyStatus({ available: false, error: message })
    if (message === 'Git status timed out') return emptyStatus({ error: message })
    return emptyStatus()
  }

  try {
    return parseGitStatus(await runGit(['status', '--porcelain=v2', '--branch', '--untracked-files=normal'], workspacePath, signal))
  } catch (error) {
    return emptyStatus({ isRepository: true, clean: false, error: safeError(error) })
  }
}

export async function runReadonlyGit(
  args: string[],
  workspacePath: string | null,
  signal?: AbortSignal
): Promise<string> {
  if (!workspacePath) throw new Error('No working folder selected for this conversation.')
  return runGit(args, workspacePath, signal)
}
