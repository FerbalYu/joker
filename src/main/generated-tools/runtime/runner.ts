import { constants, existsSync, promises as fs } from 'node:fs'
import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

import type { GeneratedToolManifest } from '../../../shared/generated-tools'
import { checkGeneratedToolCompatibility } from '../../../shared/generated-tools-compatibility'
import { GeneratedToolManifestSchema } from '../../../shared/generated-tools-schema'
import { isPathInsideWorkspace, resolveWorkspacePath } from '../../store/projects'

export const GENERATED_TOOL_FILESYSTEM_QUOTAS = Object.freeze({
  maxDeclaredFiles: 64,
  maxFileBytes: 1_048_576,
  maxPreloadBytes: 4_194_304,
  maxReadBytes: 4_194_304
})

export type GeneratedToolRunOutcome =
  | 'succeeded'
  | 'tool-failed'
  | 'runtime-failed'
  | 'timed-out'
  | 'cancelled'

export interface GeneratedToolCapabilityEvent {
  sequence: number
  capability: 'filesystem.read'
  decision: 'allowed' | 'denied'
  resourceHash: string
  reason?: string
}

export interface GeneratedToolRunRequest {
  manifest: GeneratedToolManifest
  source: string
  workspacePath: string
  input: Record<string, unknown>
  signal?: AbortSignal
}

export interface GeneratedToolRunResult {
  outcome: GeneratedToolRunOutcome
  ok: boolean
  output?: unknown
  error?: unknown
  observedCapabilities: Array<'filesystem.read'>
  capabilityEvents: GeneratedToolCapabilityEvent[]
  inputBytes: number
  outputBytes: number
  readBytes: number
  durationMs: number
  terminatedByBudget: boolean
}

interface WorkerResultMessage {
  type: 'result'
  result: GeneratedToolRunResult
}

interface StructuredRuntimeError {
  code: string
  message: string
  path?: string
  limit?: number
  actual?: number
}

function workerUrl(): URL {
  const adjacent = new URL('./generated-tool-worker.js', import.meta.url)
  if (existsSync(fileURLToPath(adjacent))) return adjacent
  return new URL('./worker.mjs', import.meta.url)
}

function structuredError(code: string, message: string, details: Omit<StructuredRuntimeError, 'code' | 'message'> = {}): StructuredRuntimeError {
  return { code, message, ...details }
}

function timeoutError(): StructuredRuntimeError {
  return structuredError('generated-tool-timeout', 'Generated Tool deadline exceeded')
}

function assertBeforeDeadline(deadline: number): void {
  if (Date.now() >= deadline) throw timeoutError()
}

async function beforeDeadline<T>(operation: Promise<T>, deadline: number, onLateValue?: (value: T) => void): Promise<T> {
  assertBeforeDeadline(deadline)
  const remaining = deadline - Date.now()
  let expired = false
  let timer: ReturnType<typeof setTimeout> | undefined
  return new Promise<T>((resolvePromise, reject) => {
    timer = setTimeout(() => {
      expired = true
      reject(timeoutError())
    }, remaining)
    operation.then((value) => {
      if (expired) {
        onLateValue?.(value)
        return
      }
      if (timer) clearTimeout(timer)
      resolvePromise(value)
    }, (error) => {
      if (expired) return
      if (timer) clearTimeout(timer)
      reject(error)
    })
  })
}

async function rejectSymlinkComponents(workspacePath: string, targetPath: string, deadline: number): Promise<void> {
  const relativePath = relative(resolve(workspacePath), resolve(targetPath))
  let current = resolve(workspacePath)
  for (const part of relativePath.split(/[\\/]+/).filter(Boolean)) {
    current = resolve(current, part)
    const stat = await beforeDeadline(fs.lstat(current), deadline)
    if (stat.isSymbolicLink()) {
      throw structuredError('generated-tool-filesystem-invalid-file', 'Declared file must not be a symbolic link', { path: relativePath.replace(/\\/g, '/') })
    }
  }
}

async function readBoundedFile(path: string, maxBytes: number, deadline: number): Promise<Buffer> {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  const handle = await beforeDeadline(fs.open(path, flags), deadline, (lateHandle) => { void lateHandle.close() })
  try {
    const stat = await beforeDeadline(handle.stat(), deadline)
    if (!stat.isFile()) {
      throw structuredError('generated-tool-filesystem-invalid-file', 'Declared path must be a regular file')
    }
    if (stat.size > maxBytes) {
      throw structuredError('generated-tool-filesystem-file-bytes-exceeded', 'Declared file exceeds the per-file preload limit', { limit: maxBytes, actual: stat.size })
    }

    const buffer = Buffer.allocUnsafe(Math.min(maxBytes + 1, stat.size + 1))
    let offset = 0
    while (offset < buffer.length) {
      assertBeforeDeadline(deadline)
      const read = await beforeDeadline(handle.read(buffer, offset, buffer.length - offset, offset), deadline)
      if (read.bytesRead === 0) break
      offset += read.bytesRead
    }
    if (offset > maxBytes) {
      throw structuredError('generated-tool-filesystem-file-bytes-exceeded', 'Declared file exceeds the per-file preload limit', { limit: maxBytes, actual: offset })
    }
    return buffer.subarray(0, offset)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function loadDeclaredFiles(manifest: GeneratedToolManifest, workspacePath: string, deadline: number): Promise<Record<string, string>> {
  const declaredFiles = manifest.permissions.filesystem.read
  if (declaredFiles.length > GENERATED_TOOL_FILESYSTEM_QUOTAS.maxDeclaredFiles) {
    throw structuredError('generated-tool-filesystem-file-count-exceeded', 'Generated Tool declares too many readable files', {
      limit: GENERATED_TOOL_FILESYSTEM_QUOTAS.maxDeclaredFiles,
      actual: declaredFiles.length
    })
  }

  const files: Record<string, string> = {}
  let preloadBytes = 0
  for (const declaredPath of declaredFiles) {
    assertBeforeDeadline(deadline)
    const unresolved = resolve(workspacePath, declaredPath)
    if (!isPathInsideWorkspace(workspacePath, unresolved)) {
      throw structuredError('generated-tool-filesystem-invalid-file', 'Declared file is outside the workspace', { path: declaredPath })
    }
    await rejectSymlinkComponents(workspacePath, unresolved, deadline)
    const canonical = resolveWorkspacePath(workspacePath, declaredPath)
    const bytes = await readBoundedFile(canonical, GENERATED_TOOL_FILESYSTEM_QUOTAS.maxFileBytes, deadline).catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error) {
        const candidate = error as StructuredRuntimeError
        if (!candidate.path) candidate.path = declaredPath.replace(/\\/g, '/')
      }
      throw error
    })
    preloadBytes += bytes.length
    if (preloadBytes > GENERATED_TOOL_FILESYSTEM_QUOTAS.maxPreloadBytes) {
      throw structuredError('generated-tool-filesystem-preload-bytes-exceeded', 'Generated Tool declared-file preload exceeds the aggregate limit', {
        path: declaredPath.replace(/\\/g, '/'),
        limit: GENERATED_TOOL_FILESYSTEM_QUOTAS.maxPreloadBytes,
        actual: preloadBytes
      })
    }
    files[declaredPath.replace(/\\/g, '/')] = bytes.toString('utf8')
  }
  return files
}

function failedResult(
  outcome: Exclude<GeneratedToolRunOutcome, 'succeeded' | 'tool-failed'>,
  error: unknown,
  startedAt: number,
  inputBytes = 0
): GeneratedToolRunResult {
  return {
    outcome,
    ok: false,
    error,
    observedCapabilities: [],
    capabilityEvents: [],
    inputBytes,
    outputBytes: 0,
    readBytes: 0,
    durationMs: Date.now() - startedAt,
    terminatedByBudget: outcome === 'timed-out' || outcome === 'cancelled'
  }
}

function normalizePreloadError(error: unknown): StructuredRuntimeError {
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' && typeof (error as { message?: unknown }).message === 'string') {
    return error as StructuredRuntimeError
  }
  return structuredError('generated-tool-filesystem-preload-failed', error instanceof Error ? error.message : String(error))
}

export async function runGeneratedTool(request: GeneratedToolRunRequest): Promise<GeneratedToolRunResult> {
  const startedAt = Date.now()
  const compatibility = checkGeneratedToolCompatibility(request.manifest)
  if (!compatibility.compatible) {
    return failedResult('runtime-failed', {
      code: 'generated-tool-incompatible',
      reasons: compatibility.reasons
    }, startedAt)
  }
  const manifest = GeneratedToolManifestSchema.parse(request.manifest)
  const deadline = startedAt + manifest.limits.timeoutMs
  if (manifest.permissions.filesystem.write.length > 0
    || manifest.permissions.network.hosts.length > 0
    || manifest.permissions.process.commands.length > 0
    || manifest.permissions.environment.keys.length > 0
    || manifest.permissions.secrets.handles.length > 0
    || manifest.dependencies.length > 0) {
    return failedResult('runtime-failed', 'Generated Tool requests capabilities unsupported by the project-read runtime', startedAt)
  }
  const inputJson = JSON.stringify(request.input)
  const inputBytes = Buffer.byteLength(inputJson, 'utf8')
  if (inputBytes > manifest.limits.maxInputBytes) {
    return failedResult('runtime-failed', 'Generated Tool input exceeds manifest limit', startedAt, inputBytes)
  }

  let files: Record<string, string>
  try {
    files = await loadDeclaredFiles(manifest, request.workspacePath, deadline)
  } catch (error) {
    const normalized = normalizePreloadError(error)
    return failedResult(normalized.code === 'generated-tool-timeout' ? 'timed-out' : 'runtime-failed', normalized, startedAt, inputBytes)
  }
  if (Date.now() >= deadline) return failedResult('timed-out', timeoutError(), startedAt, inputBytes)

  const worker = new Worker(workerUrl())
  return new Promise((resolvePromise) => {
    let settled = false
    let terminalCause: 'timed-out' | 'cancelled' | null = null
    let forceTimer: NodeJS.Timeout | undefined
    const timeoutTimer = setTimeout(() => {
      terminalCause = 'timed-out'
      worker.postMessage({ type: 'cancel' })
      forceTimer = setTimeout(() => finish(failedResult('timed-out', timeoutError(), startedAt, inputBytes)), 100)
      forceTimer.unref()
    }, Math.max(0, deadline - Date.now()))
    timeoutTimer.unref()
    const finish = (result: GeneratedToolRunResult) => {
      if (settled) return
      settled = true
      cleanup()
      void worker.terminate()
      resolvePromise({ ...result, durationMs: Date.now() - startedAt })
    }
    const onAbort = () => {
      if (terminalCause) return
      terminalCause = 'cancelled'
      worker.postMessage({ type: 'cancel' })
      forceTimer = setTimeout(() => finish(failedResult('cancelled', 'cancelled', startedAt, inputBytes)), 100)
      forceTimer.unref()
    }
    const cleanup = () => {
      clearTimeout(timeoutTimer)
      if (forceTimer) clearTimeout(forceTimer)
      request.signal?.removeEventListener('abort', onAbort)
    }
    request.signal?.addEventListener('abort', onAbort, { once: true })
    if (request.signal?.aborted) {
      onAbort()
      return
    }
    worker.once('error', (error) => finish(failedResult(terminalCause ?? 'runtime-failed', error.message, startedAt, inputBytes)))
    worker.once('exit', (code) => {
      if (!settled) finish(failedResult(terminalCause ?? 'runtime-failed', `Generated Tool runner exited with code ${code}`, startedAt, inputBytes))
    })
    worker.on('message', (message: WorkerResultMessage) => {
      if (message?.type !== 'result') return
      if (terminalCause) finish(failedResult(terminalCause, terminalCause === 'timed-out' ? timeoutError() : terminalCause, startedAt, inputBytes))
      else finish(message.result)
    })
    worker.postMessage({
      type: 'run',
      request: {
        source: request.source,
        entrypoint: manifest.entrypoint,
        input: request.input,
        files,
        deadline,
        readBudgetBytes: GENERATED_TOOL_FILESYSTEM_QUOTAS.maxReadBytes,
        limits: manifest.limits
      }
    })
  })
}
