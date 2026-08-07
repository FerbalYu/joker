import crypto from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname } from 'node:path'

const LOCK_STALE_MS = 30_000
const LOCK_TIMEOUT_MS = 5_000
const LOCK_RETRY_MS = 10
const LOCK_BOUNDARY_RETRIES = 5
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4))

type DirectoryLockFileSystem = {
  mkdirSync: typeof mkdirSync
  readFileSync: typeof readFileSync
  renameSync: typeof renameSync
  rmSync: typeof rmSync
  statSync: typeof statSync
  writeFileSync: typeof writeFileSync
}

export interface DirectoryLockOptions {
  lockPath?: string
  staleMs?: number
  timeoutMs?: number
  retryMs?: number
  boundaryRetries?: number
  platform?: NodeJS.Platform
  now?: () => number
  sleep?: (milliseconds: number) => void
  processIsAlive?: (pid: number) => boolean
  fileSystem?: Partial<DirectoryLockFileSystem>
}

export class DirectoryLockTimeoutError extends Error {
  constructor(
    readonly targetPath: string,
    readonly lockPath: string,
    readonly timeoutMs: number,
    readonly lastErrorCode?: string,
    readonly ownerDescription?: string
  ) {
    super([
      `Timed out acquiring directory lock for ${targetPath} after ${timeoutMs}ms`,
      `lock=${lockPath}`,
      lastErrorCode ? `lastError=${lastErrorCode}` : '',
      ownerDescription ? `owner=${ownerDescription}` : ''
    ].filter(Boolean).join('; '))
    this.name = 'DirectoryLockTimeoutError'
  }
}

function defaultSleep(milliseconds: number): void {
  if (milliseconds > 0) Atomics.wait(sleepBuffer, 0, 0, milliseconds)
}

function defaultProcessIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

function isTransientBoundaryError(error: unknown, platform: NodeJS.Platform): boolean {
  const code = errorCode(error)
  return code === 'EEXIST' || (platform === 'win32' && (code === 'EPERM' || code === 'EACCES'))
}

function lockOwnerPath(lock: string): string {
  return `${lock}/owner.json`
}

function readLockOwner(lock: string, fs: DirectoryLockFileSystem): { pid: number; token?: string; createdAt: number } | null {
  try {
    const owner = JSON.parse(fs.readFileSync(lockOwnerPath(lock), 'utf8')) as { pid?: unknown; token?: unknown; createdAt?: unknown }
    return {
      pid: typeof owner.pid === 'number' ? owner.pid : 0,
      token: typeof owner.token === 'string' ? owner.token : undefined,
      createdAt: typeof owner.createdAt === 'number' ? owner.createdAt : 0
    }
  } catch {
    return null
  }
}

function lockOwnerDescription(lock: string, fs: DirectoryLockFileSystem): string | undefined {
  const owner = readLockOwner(lock, fs)
  if (owner) return `pid ${owner.pid || 'unknown'}, createdAt ${owner.createdAt || 'unknown'}`
  try {
    return `unreadable owner, lock mtime ${new Date(fs.statSync(lock).mtimeMs).toISOString()}`
  } catch {
    return undefined
  }
}

function isStaleLock(
  lock: string,
  staleMs: number,
  now: () => number,
  processIsAlive: (pid: number) => boolean,
  fs: DirectoryLockFileSystem
): boolean {
  const owner = readLockOwner(lock, fs)
  if (owner) return !processIsAlive(owner.pid) && now() - owner.createdAt > staleMs
  try {
    return now() - fs.statSync(lock).mtimeMs > staleMs
  } catch {
    return false
  }
}

function removeLockDirectory(
  lock: string,
  platform: NodeJS.Platform,
  boundaryRetries: number,
  sleep: (milliseconds: number) => void,
  retryMs: number,
  fs: DirectoryLockFileSystem
): void {
  for (let attempt = 0; attempt <= boundaryRetries; attempt += 1) {
    try {
      fs.rmSync(lock, { recursive: true, force: true })
      return
    } catch (error) {
      if (!isTransientBoundaryError(error, platform) || attempt === boundaryRetries) return
      sleep(retryMs)
    }
  }
}

function removeOwnedLock(
  lock: string,
  token: string,
  platform: NodeJS.Platform,
  boundaryRetries: number,
  sleep: (milliseconds: number) => void,
  retryMs: number,
  fs: DirectoryLockFileSystem
): void {
  for (let attempt = 0; attempt <= boundaryRetries; attempt += 1) {
    try {
      const owner = JSON.parse(fs.readFileSync(lockOwnerPath(lock), 'utf8')) as { token?: unknown }
      if (owner.token === token) removeLockDirectory(lock, platform, boundaryRetries, sleep, retryMs, fs)
      return
    } catch (error) {
      if (!isTransientBoundaryError(error, platform) || attempt === boundaryRetries) return
      sleep(retryMs)
    }
  }
}

/** Serializes a synchronous transaction with an atomically-created lock directory. */
export function withDirectoryLock<T>(targetPath: string, operation: () => T, options: DirectoryLockOptions = {}): T {
  mkdirSync(dirname(targetPath), { recursive: true })
  const lock = options.lockPath ?? `${targetPath}.lock`
  const staleMs = Math.max(0, options.staleMs ?? LOCK_STALE_MS)
  const timeoutMs = Math.max(0, options.timeoutMs ?? LOCK_TIMEOUT_MS)
  const retryMs = Math.max(0, options.retryMs ?? LOCK_RETRY_MS)
  const boundaryRetries = Math.max(0, Math.floor(options.boundaryRetries ?? LOCK_BOUNDARY_RETRIES))
  const platform = options.platform ?? process.platform
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const processIsAlive = options.processIsAlive ?? defaultProcessIsAlive
  const fs: DirectoryLockFileSystem = {
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
    ...options.fileSystem
  }
  const token = crypto.randomUUID()
  const deadline = now() + timeoutMs
  let lastErrorCode: string | undefined

  while (true) {
    try {
      fs.mkdirSync(lock)
    } catch (error) {
      lastErrorCode = errorCode(error)
      if (!isTransientBoundaryError(error, platform)) throw error
      if (isStaleLock(lock, staleMs, now, processIsAlive, fs)) {
        const claimed = `${lock}.stale-${process.pid}-${crypto.randomUUID()}`
        try {
          fs.renameSync(lock, claimed)
          removeLockDirectory(claimed, platform, boundaryRetries, sleep, retryMs, fs)
          continue
        } catch (claimError) {
          lastErrorCode = errorCode(claimError)
          if (lastErrorCode !== 'ENOENT' && !isTransientBoundaryError(claimError, platform)) throw claimError
        }
      }
      if (now() >= deadline) {
        throw new DirectoryLockTimeoutError(targetPath, lock, timeoutMs, lastErrorCode, lockOwnerDescription(lock, fs))
      }
      sleep(Math.min(retryMs, Math.max(0, deadline - now())))
      continue
    }

    let ownerWritten = false
    try {
      for (let attempt = 0; attempt <= boundaryRetries; attempt += 1) {
        try {
          fs.writeFileSync(lockOwnerPath(lock), JSON.stringify({ pid: process.pid, token, createdAt: now() }), 'utf8')
          ownerWritten = true
          break
        } catch (error) {
          lastErrorCode = errorCode(error)
          if (!isTransientBoundaryError(error, platform) || attempt === boundaryRetries || now() >= deadline) throw error
          sleep(retryMs)
        }
      }
      if (!ownerWritten) throw new Error(`Failed to write directory lock owner for ${targetPath}`)
      return operation()
    } finally {
      if (ownerWritten) removeOwnedLock(lock, token, platform, boundaryRetries, sleep, retryMs, fs)
      else removeLockDirectory(lock, platform, boundaryRetries, sleep, retryMs, fs)
    }
  }
}

export function withFileLock<T>(path: string, operation: () => T): T {
  return withDirectoryLock(path, operation)
}

function fsyncFile(path: string): void {
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } catch {
    // Some Windows filesystems reject fsync for newly-created files.
  } finally {
    closeSync(fd)
  }
}

export function writeJsonWithBackup(path: string, value: unknown): void {
  withFileLock(path, () => writeJsonWithBackupUnlocked(path, value))
}

function writeJsonWithBackupUnlocked(path: string, value: unknown, preserveBackup = false): void {
  mkdirSync(dirname(path), { recursive: true })
  const tempPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fsyncFile(tempPath)
    if (!preserveBackup && existsSync(path)) {
      copyFileSync(path, `${path}.bak`)
      fsyncFile(`${path}.bak`)
    }
    try {
      renameSync(tempPath, path)
    } catch (error) {
      if (process.platform !== 'win32' || !existsSync(path)) throw error
      unlinkSync(path)
      renameSync(tempPath, path)
    }
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath)
  }
}

export function readJsonWithBackup<T>(path: string, parse: (value: unknown) => T): T | null {
  return withFileLock(path, () => readJsonWithBackupUnlocked(path, parse).value)
}

export class CorruptAtomicJsonError extends Error {
  constructor(readonly path: string) {
    super(`Atomic JSON state is corrupt: ${path}`)
    this.name = 'CorruptAtomicJsonError'
  }
}

export function readJsonWithBackupStrict<T>(path: string, parse: (value: unknown) => T): T | null {
  return withFileLock(path, () => {
    const result = readJsonWithBackupUnlocked(path, parse)
    if (result.corrupt) throw new CorruptAtomicJsonError(path)
    if (result.value !== null && result.source === 'backup') writeJsonWithBackupUnlocked(path, result.value, true)
    return result.value
  })
}

function readJsonWithBackupUnlocked<T>(path: string, parse: (value: unknown) => T): { value: T | null; corrupt: boolean; source?: 'primary' | 'backup' } {
  let found = false
  const candidates = [{ path, source: 'primary' as const }, { path: `${path}.bak`, source: 'backup' as const }]
  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue
    found = true
    try {
      return { value: parse(JSON.parse(readFileSync(candidate.path, 'utf8'))), corrupt: false, source: candidate.source }
    } catch {
      // Fall through to backup; strict callers fail closed when both are invalid.
    }
  }
  return { value: null, corrupt: found }
}

export function updateJsonWithBackup<T>(
  path: string,
  parse: (value: unknown) => T,
  initial: () => T,
  update: (current: T) => T
): T {
  return withFileLock(path, () => {
    const current = readJsonWithBackupUnlocked(path, parse).value ?? initial()
    const next = update(current)
    writeJsonWithBackupUnlocked(path, next)
    return next
  })
}

export function updateJsonWithBackupStrict<T>(
  path: string,
  parse: (value: unknown) => T,
  initial: () => T,
  update: (current: T) => T
): T {
  return withFileLock(path, () => {
    const result = readJsonWithBackupUnlocked(path, parse)
    if (result.corrupt) throw new CorruptAtomicJsonError(path)
    const next = update(result.value ?? initial())
    writeJsonWithBackupUnlocked(path, next)
    return next
  })
}

export function writeJsonOnce(path: string, value: unknown): void {
  withFileLock(path, () => {
    if (existsSync(path) || existsSync(`${path}.bak`)) throw new Error(`Atomic JSON state already exists: ${path}`)
    writeJsonWithBackupUnlocked(path, value)
  })
}
