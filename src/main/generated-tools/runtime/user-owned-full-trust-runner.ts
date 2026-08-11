import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fork, spawn, type ChildProcess, type Serializable } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { GeneratedToolManifest } from '../../../shared/generated-tools'
import { GeneratedToolManifestSchema } from '../../../shared/generated-tools-schema'
import { hostRuntimeEnvironment } from './host-runtime-bin'

export type UserOwnedFullTrustCapability =
  | 'filesystem.write'
  | 'network.request'
  | 'process.run'
  | 'environment.read'
  | 'secrets.read'

export interface UserOwnedFullTrustCapabilityEvent {
  sequence: number
  capability: UserOwnedFullTrustCapability
  decision: 'allowed' | 'denied'
  resourceHash: string
  reason?: string
}

export interface UserOwnedFullTrustRunRequest {
  manifest: GeneratedToolManifest
  source: string
  /** Absolute generated entrypoint path; preserves normal Node relative require resolution. */
  entrypointPath?: string
  workspacePath: string
  input: Record<string, unknown>
  signal?: AbortSignal
  environment?: NodeJS.ProcessEnv
  secrets?: Record<string, string>
}

export interface UserOwnedFullTrustRunResult {
  outcome: 'succeeded' | 'tool-failed' | 'runtime-failed' | 'timed-out' | 'cancelled'
  ok: boolean
  output?: unknown
  error?: unknown
  capabilityEvents: UserOwnedFullTrustCapabilityEvent[]
  durationMs: number
  terminatedByBudget: boolean
}

interface WorkerMessage {
  type: 'result'
  result: UserOwnedFullTrustRunResult
}

function workerPath(): string {
  const built = new URL('./user-owned-full-trust-worker.js', import.meta.url)
  if (existsSync(fileURLToPath(built))) return fileURLToPath(built)
  return fileURLToPath(new URL('./user-owned-full-trust-worker.mjs', import.meta.url))
}

function failed(
  outcome: Extract<UserOwnedFullTrustRunResult['outcome'], 'runtime-failed' | 'timed-out' | 'cancelled'>,
  error: unknown,
  startedAt: number
): UserOwnedFullTrustRunResult {
  return {
    outcome,
    ok: false,
    error,
    capabilityEvents: [],
    durationMs: Date.now() - startedAt,
    terminatedByBudget: outcome === 'timed-out' || outcome === 'cancelled'
  }
}

function fullEnvironment(request: UserOwnedFullTrustRunRequest): NodeJS.ProcessEnv {
  return hostRuntimeEnvironment({ ...process.env, ...request.environment })
}

function terminateProcessTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.killed) return
  if (process.platform === 'win32' && child.pid) {
    const taskkill = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      detached: true,
      windowsHide: true
    })
    taskkill.unref()
  }
  try { child.kill('SIGKILL') } catch { /* process already exited */ }
}

/**
 * Executes user-owned full-trust source only in a disposable Node child process.
 * This profile intentionally runs generated code with the current desktop user
 * account permissions. The child process only keeps cancellation isolated from
 * Electron; it is not a capability or policy boundary.
 */
export async function runUserOwnedFullTrustTool(request: UserOwnedFullTrustRunRequest): Promise<UserOwnedFullTrustRunResult> {
  const startedAt = Date.now()
  const manifest = GeneratedToolManifestSchema.parse(request.manifest)
  if (!resolve(request.workspacePath)) return failed('runtime-failed', 'Generated Tool workspace is invalid', startedAt)
  if (request.signal?.aborted) return failed('cancelled', 'cancelled', startedAt)

  const child = fork(workerPath(), [], {
    cwd: resolve(request.workspacePath),
    env: fullEnvironment(request),
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    serialization: 'json',
    execArgv: []
  })
  return new Promise((resolvePromise) => {
    let settled = false
    let terminal: 'timed-out' | 'cancelled' | null = null
    let forceTimer: NodeJS.Timeout | undefined
    const finish = (result: UserOwnedFullTrustRunResult): void => {
      if (settled) return
      settled = true
      cleanup()
      let resolved = false
      const resolveAfterExit = (): void => {
        if (resolved) return
        resolved = true
        resolvePromise({ ...result, durationMs: Date.now() - startedAt })
      }
      child.once('close', resolveAfterExit)
      terminateProcessTree(child)
      const closeDeadline = setTimeout(resolveAfterExit, 1_000)
      closeDeadline.unref()
    }
    const send = (message: Serializable): void => {
      if (!child.connected || child.exitCode !== null) return
      try {
        child.send(message, (error) => {
          if (error) finish(failed(terminal ?? 'runtime-failed', error.message, startedAt))
        })
      } catch (error) {
        finish(failed(
          terminal ?? 'runtime-failed',
          error instanceof Error ? error.message : String(error),
          startedAt
        ))
      }
    }
    const onAbort = (): void => {
      if (terminal) return
      terminal = 'cancelled'
      send({ type: 'cancel' })
      forceTimer = setTimeout(() => finish(failed('cancelled', 'cancelled', startedAt)), 100)
      forceTimer.unref()
    }
    const cleanup = (): void => {
      if (forceTimer) clearTimeout(forceTimer)
      request.signal?.removeEventListener('abort', onAbort)
      child.removeAllListeners()
    }
    request.signal?.addEventListener('abort', onAbort, { once: true })
    child.once('error', (error) => finish(failed(terminal ?? 'runtime-failed', error.message, startedAt)))
    child.once('spawn', () => {
      queueMicrotask(() => send({
        type: 'run',
        request: {
          source: request.source,
          entrypointPath: request.entrypointPath,
          input: request.input,
          limits: manifest.limits,
          permissions: manifest.permissions,
          workspacePath: resolve(request.workspacePath),
          environment: fullEnvironment(request),
          secrets: request.secrets ?? {}
        }
      })
      )
    })
    child.once('exit', (code) => {
      // IPC messages can be delivered after the child exit notification.
      // Give a completed worker one event-loop turn to deliver its terminal result.
      setImmediate(() => {
        if (!settled) {
          finish(failed(terminal ?? 'runtime-failed', `Generated Tool child exited with code ${code}`, startedAt))
        }
      })
    })
    child.on('message', (message: WorkerMessage) => {
      if (message?.type !== 'result') return
      if (terminal) finish(failed(terminal, terminal === 'timed-out' ? 'Generated Tool deadline exceeded' : 'cancelled', startedAt))
      else finish(message.result)
    })
  })
}

export function hashUserOwnedFullTrustResource(resource: string): string {
  return createHash('sha256').update(resource).digest('hex')
}
