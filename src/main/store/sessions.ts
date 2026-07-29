import * as electron from 'electron'
import { join } from 'node:path'
import {
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import type { ChatMessage, SessionMeta } from '@shared/types'
import { getMessageText, validateChatParts } from '../../shared/messages'
import { cleanupGeneratedImages } from './generated-images'
import { resolveProjectPath } from './projects'
import { getJokerHomeDir } from './paths'

interface StoredSession extends SessionMeta {
  messages: ChatMessage[]
}

interface SessionEnvelope {
  schemaVersion: 1
  data: StoredSession
}

const SESSION_SCHEMA_VERSION = 1
const SESSION_LOCK_STALE_MS = 30_000
const SESSION_LOCK_RETRY_MS = 5
const SESSION_LOCK_TIMEOUT_MS = 30_000
let sessionsDataDirOverride: string | null = null

/** Test-only storage override; production callers should use the default app directory. */
export function setSessionsDataDirForTests(dir: string | null): void {
  sessionsDataDirOverride = dir
}

function getDataDir(): string {
  if (sessionsDataDirOverride) return sessionsDataDirOverride
  const home = typeof electron.app?.getPath === 'function' ? electron.app.getPath('home') : getJokerHomeDir()
  return join(home, '.joker', 'sessions')
}

function ensureDataDir(): void {
  const dir = getDataDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function isValidSessionId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id)
}

function getSessionPath(id: string): string {
  if (!isValidSessionId(id)) throw new Error('Invalid session id')
  return join(getDataDir(), `${id}.json`)
}

function isValidMessage(message: unknown): message is ChatMessage {
  if (!message || typeof message !== 'object') return false
  const candidate = message as Partial<ChatMessage>
  if (typeof candidate.id !== 'string' || !candidate.id || typeof candidate.role !== 'string') return false
  if (!['user', 'assistant', 'system'].includes(candidate.role)) return false
  if (typeof candidate.content !== 'string' || typeof candidate.createdAt !== 'number' || !Number.isFinite(candidate.createdAt)) return false
  return candidate.parts === undefined || validateChatParts(candidate.parts)
}

function isValidStoredSession(value: unknown, expectedId?: string): value is StoredSession {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<StoredSession>
  return typeof candidate.id === 'string' && isValidSessionId(candidate.id) && (!expectedId || candidate.id === expectedId) &&
    typeof candidate.title === 'string' && candidate.title.length <= 1000 &&
    typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt) &&
    typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt) &&
    (candidate.projectId === undefined || typeof candidate.projectId === 'string') &&
    Array.isArray(candidate.messages) && candidate.messages.every(isValidMessage)
}

function decodeStoredSession(raw: unknown, expectedId: string): StoredSession | null {
  if (!raw || typeof raw !== 'object') return null
  const candidate = raw as Partial<SessionEnvelope> & Partial<StoredSession>
  const data = candidate.schemaVersion === SESSION_SCHEMA_VERSION ? candidate.data : raw
  return isValidStoredSession(data, expectedId) ? data : null
}

function readSessionFile(path: string, expectedId: string): StoredSession | null {
  try {
    return decodeStoredSession(JSON.parse(readFileSync(path, 'utf-8')), expectedId)
  } catch {
    return null
  }
}

function readSessionWithBackupUnlocked(id: string): StoredSession | null {
  const path = getSessionPath(id)
  if (!existsSync(path)) return readSessionFile(`${path}.bak`, id)
  return readSessionFile(path, id) ?? readSessionFile(`${path}.bak`, id)
}

function lockPath(id: string): string {
  return `${getSessionPath(id)}.lock`
}

function lockOwnerPath(lock: string): string {
  return join(lock, 'owner.json')
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function isStaleLock(lock: string): boolean {
  try {
    const owner = JSON.parse(readFileSync(lockOwnerPath(lock), 'utf8')) as { pid?: unknown; createdAt?: unknown }
    const pid = typeof owner.pid === 'number' ? owner.pid : 0
    const createdAt = typeof owner.createdAt === 'number' ? owner.createdAt : 0
    return !processIsAlive(pid) && Date.now() - createdAt > SESSION_LOCK_STALE_MS
  } catch {
    try {
      return Date.now() - statSync(lock).mtimeMs > SESSION_LOCK_STALE_MS
    } catch {
      return false
    }
  }
}

function removeLock(lock: string, token: string): void {
  try {
    const owner = JSON.parse(readFileSync(lockOwnerPath(lock), 'utf8')) as { token?: unknown }
    if (owner.token !== token) return
    rmSync(lock, { recursive: true, force: true })
  } catch {
    // Another process may have reclaimed a stale lock after our transaction ended.
  }
}

function withSessionLock<T>(id: string, operation: () => T): T {
  ensureDataDir()
  const lock = lockPath(id)
  const token = crypto.randomUUID()
  const deadline = Date.now() + SESSION_LOCK_TIMEOUT_MS
  while (true) {
    try {
      mkdirSync(lock)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (isStaleLock(lock)) {
        try { rmSync(lock, { recursive: true, force: true }) } catch { /* another writer may win the race */ }
        continue
      }
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring session lock for ${id}`)
      const waitUntil = Date.now() + SESSION_LOCK_RETRY_MS
      while (Date.now() < waitUntil) {
        // Synchronous callers need a bounded sleep while preserving a cross-process transaction.
      }
      continue
    }

    try {
      writeFileSync(lockOwnerPath(lock), JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }), 'utf8')
      return operation()
    } finally {
      removeLock(lock, token)
    }
  }
}

function readSessionWithBackup(id: string): StoredSession | null {
  return withSessionLock(id, () => readSessionWithBackupUnlocked(id))
}

function writeSessionUnlocked(session: StoredSession): void {
  ensureDataDir()
  const path = getSessionPath(session.id)
  const tempPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    const envelope: SessionEnvelope = { schemaVersion: SESSION_SCHEMA_VERSION, data: session }
    writeFileSync(tempPath, JSON.stringify(envelope, null, 2), 'utf-8')
    const fd = openSync(tempPath, 'r')
    try {
      fsyncSync(fd)
    } catch {
      // Some Windows filesystems do not allow fsync on a newly-created file.
    } finally {
      closeSync(fd)
    }

    const backupPath = `${path}.bak`
    if (existsSync(path) && readSessionFile(path, session.id)) {
      copyFileSync(path, backupPath)
      try {
        const backupFd = openSync(backupPath, 'r')
        try {
          fsyncSync(backupFd)
        } catch {
          // Best-effort directory/file durability on platforms that reject fsync.
        } finally {
          closeSync(backupFd)
        }
      } catch {
        // The primary write remains valid even if backup durability cannot be synced.
      }
    }
    try {
      renameSync(tempPath, path)
    } catch (error) {
      // Windows cannot replace an existing destination with renameSync; the backup above keeps recovery possible.
      if (process.platform !== 'win32' || !existsSync(path)) throw error
      unlinkSync(path)
      renameSync(tempPath, path)
    }
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath)
  }
}

export function createSession(title = 'New conversation'): SessionMeta {
  ensureDataDir()
  const now = Date.now()
  const session: StoredSession = {
    id: crypto.randomUUID(),
    title: title.slice(0, 1000),
    createdAt: now,
    updatedAt: now,
    messages: []
  }
  withSessionLock(session.id, () => writeSessionUnlocked(session))
  return { id: session.id, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt }
}

export function getSession(id: string): StoredSession | null {
  return readSessionWithBackup(id)
}

export function listSessions(): SessionMeta[] {
  ensureDataDir()
  const files = readdirSync(getDataDir())
  const ids = new Set(
    files
      .filter((file) => file.endsWith('.json') || file.endsWith('.json.bak'))
      .map((file) => file.endsWith('.json.bak') ? file.slice(0, -'.json.bak'.length) : file.slice(0, -'.json'.length))
      .filter(isValidSessionId)
  )
  const sessions: SessionMeta[] = []
  for (const id of ids) {
    const data = readSessionWithBackup(id)
    if (!data) continue
    sessions.push({
      id: data.id,
      title: data.title,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      ...(typeof data.projectId === 'string' ? { projectId: data.projectId } : {})
    })
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function appendMessage(sessionId: string, message: ChatMessage): boolean {
  if (!isValidMessage(message)) return false
  return withSessionLock(sessionId, () => {
    const session = readSessionWithBackupUnlocked(sessionId)
    if (!session) return false

    session.messages.push(message)
    session.updatedAt = Date.now()
    if (session.title === 'New conversation') {
      const firstUser = session.messages.find((m) => m.role === 'user')
      if (firstUser) {
        const text = getMessageText(firstUser)
        session.title = text ? text.slice(0, 50).replace(/\n/g, ' ') : 'Image message'
      }
    }

    writeSessionUnlocked(session)
    return true
  })
}

export function replaceMessages(sessionId: string, messages: ChatMessage[]): boolean {
  if (!messages.every(isValidMessage)) return false
  return withSessionLock(sessionId, () => {
    const session = readSessionWithBackupUnlocked(sessionId)
    if (!session) return false
    session.messages = messages
    session.updatedAt = Date.now()
    if (session.title === 'New conversation') {
      const firstUser = session.messages.find((message) => message.role === 'user')
      if (firstUser) {
        const text = getMessageText(firstUser)
        session.title = text ? text.slice(0, 50).replace(/\n/g, ' ') : 'Image message'
      }
    }
    writeSessionUnlocked(session)
    return true
  })
}

export function setSessionProject(sessionId: string, projectId: string | null): boolean {
  return withSessionLock(sessionId, () => {
    const session = readSessionWithBackupUnlocked(sessionId)
    if (!session) return false
    if (projectId !== null && (!/^[A-Za-z0-9_-]{8,100}$/.test(projectId) || !resolveProjectPath(projectId))) return false

    if (projectId === null) delete session.projectId
    else session.projectId = projectId
    session.updatedAt = Date.now()
    writeSessionUnlocked(session)
    return true
  })
}

export function deleteSession(id: string): boolean {
  return withSessionLock(id, () => {
    const path = getSessionPath(id)
    if (!existsSync(path) && !existsSync(`${path}.bak`)) return false
    if (existsSync(path)) unlinkSync(path)
    if (existsSync(`${path}.bak`)) unlinkSync(`${path}.bak`)
    cleanupGeneratedImages(id)
    return true
  })
}

export function renameSession(id: string, title: string): boolean {
  return withSessionLock(id, () => {
    const session = readSessionWithBackupUnlocked(id)
    if (!session) return false
    session.title = title.slice(0, 1000)
    session.updatedAt = Date.now()
    writeSessionUnlocked(session)
    return true
  })
}
