import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { detectGitStatus, parseGitStatus } from './status'

void test('parseGitStatus returns branch and change counts without paths', () => {
  const output = [
    '# branch.head test',
    '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 abc def src/file.ts',
    '? untracked.txt',
    'u UU N... 100644 100644 100644 100644 abc def ghi conflict.ts'
  ].join('\n')
  const status = parseGitStatus(output)
  assert.equal(status.branch, 'test')
  assert.equal(status.ahead, 2)
  assert.equal(status.behind, 1)
  assert.equal(status.changed, 2)
  assert.equal(status.untracked, 1)
  assert.equal(status.conflicted, 1)
  assert.equal(status.clean, false)
})

void test('detectGitStatus finds a repository from a selected child folder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'joker-git-'))
  const child = join(root, 'packages', 'app')
  mkdirSync(child, { recursive: true })
  try {
    execFileSync('git', ['init', '-b', 'test', root], { stdio: 'ignore' })
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Joker Test'])
    writeFileSync(join(root, 'README.md'), 'hello')
    execFileSync('git', ['-C', root, 'add', '.'])
    execFileSync('git', ['-C', root, 'commit', '-m', 'init'], { stdio: 'ignore' })
    writeFileSync(join(root, 'README.md'), 'changed')
    const status = await detectGitStatus(child)
    assert.equal(status.isRepository, true)
    assert.equal(status.available, true)
    assert.equal(status.branch, 'test')
    assert.equal(status.changed, 1)
    assert.equal(status.clean, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

void test('detectGitStatus reports non-repository directories without throwing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'joker-no-git-'))
  try {
    const status = await detectGitStatus(root)
    assert.equal(status.isRepository, false)
    assert.equal(status.available, true)
    assert.equal(status.clean, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
