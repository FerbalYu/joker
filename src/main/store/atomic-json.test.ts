import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CorruptAtomicJsonError,
  DirectoryLockTimeoutError,
  readJsonWithBackupStrict,
  updateJsonWithBackupStrict,
  withDirectoryLock,
  writeJsonWithBackup
} from './atomic-json'

function parse(value: unknown): { revision: number } {
  if (!value || typeof value !== 'object' || !Number.isInteger((value as { revision?: unknown }).revision)) throw new Error('invalid')
  return value as { revision: number }
}

void test('directory lock retries transient Windows boundary errors before entering', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-directory-lock-'))
  const path = join(home, 'state.json')
  let mkdirAttempts = 0
  let ownerWriteAttempts = 0
  let operated = false
  try {
    withDirectoryLock(path, () => { operated = true }, {
      platform: 'win32',
      retryMs: 1,
      sleep: () => undefined,
      fileSystem: {
        mkdirSync: ((lock: string) => {
          mkdirAttempts += 1
          if (mkdirAttempts === 1) throw Object.assign(new Error('scanner race'), { code: 'EPERM' })
          mkdirSync(lock)
        }) as typeof mkdirSync,
        writeFileSync: ((file: string, data: string, encoding: BufferEncoding) => {
          ownerWriteAttempts += 1
          if (ownerWriteAttempts === 1) throw Object.assign(new Error('scanner race'), { code: 'EACCES' })
          return writeFileSync(file, data, encoding)
        }) as typeof writeFileSync
      }
    })
    assert.equal(operated, true)
    assert.equal(mkdirAttempts, 2)
    assert.equal(ownerWriteAttempts, 2)
    assert.equal(existsSync(`${path}.lock`), false)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('directory lock removes an ownerless lock when owner initialization exhausts retries', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-directory-lock-'))
  const path = join(home, 'state.json')
  try {
    assert.throws(() => withDirectoryLock(path, () => undefined, {
      platform: 'win32',
      boundaryRetries: 1,
      retryMs: 0,
      sleep: () => undefined,
      fileSystem: {
        writeFileSync: (() => { throw Object.assign(new Error('blocked owner write'), { code: 'EPERM' }) }) as typeof writeFileSync
      }
    }), /blocked owner write/)
    assert.equal(existsSync(`${path}.lock`), false)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('directory lock reclaims stale locks with an atomic rename claim', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-directory-lock-'))
  const path = join(home, 'state.json')
  const lock = `${path}.lock`
  mkdirSync(lock, { recursive: true })
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 999999, token: 'dead', createdAt: 1 }), 'utf8')
  let operated = false
  try {
    withDirectoryLock(path, () => { operated = true }, {
      staleMs: 1,
      now: () => 100,
      processIsAlive: () => false,
      retryMs: 0,
      sleep: () => undefined
    })
    assert.equal(operated, true)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('directory lock timeout reports target, lock path, owner, and boundary error', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-directory-lock-'))
  const path = join(home, 'state.json')
  const lock = `${path}.lock`
  mkdirSync(lock, { recursive: true })
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'live', createdAt: 10 }), 'utf8')
  let now = 10
  try {
    assert.throws(() => withDirectoryLock(path, () => undefined, {
      timeoutMs: 2,
      retryMs: 1,
      now: () => now,
      sleep: (milliseconds) => { now += milliseconds },
      processIsAlive: () => true
    }), (error: unknown) => {
      assert.ok(error instanceof DirectoryLockTimeoutError)
      const message = (error as Error).message
      assert.match(message, /after 2ms/)
      assert.match(message, /state\.json\.lock/)
      assert.match(message, /lastError=EEXIST/)
      assert.match(message, new RegExp(`pid ${process.pid}`))
      return true
    })
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('strict atomic JSON repairs a corrupt primary from a valid backup', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-atomic-json-'))
  const path = join(home, 'state.json')
  try {
    writeJsonWithBackup(path, { revision: 1 })
    writeJsonWithBackup(path, { revision: 2 })
    writeFileSync(path, '{broken', 'utf8')
    assert.deepEqual(readJsonWithBackupStrict(path, parse), { revision: 1 })
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { revision: 1 })
    assert.deepEqual(JSON.parse(readFileSync(`${path}.bak`, 'utf8')), { revision: 1 })
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('strict atomic JSON fails closed when primary and backup are corrupt', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-atomic-json-'))
  const path = join(home, 'state.json')
  try {
    mkdirSync(home, { recursive: true })
    writeFileSync(path, '{broken', 'utf8')
    writeFileSync(`${path}.bak`, '{also-broken', 'utf8')
    assert.throws(() => readJsonWithBackupStrict(path, parse), CorruptAtomicJsonError)
    assert.throws(() => updateJsonWithBackupStrict(path, parse, () => ({ revision: 0 }), (state) => state), CorruptAtomicJsonError)
    assert.equal(readFileSync(path, 'utf8'), '{broken')
  } finally { rmSync(home, { recursive: true, force: true }) }
})
