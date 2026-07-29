import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import {
  canonicalizeProjectPath,
  isPathInsideWorkspace,
  normalizeProjectState,
  resolveWorkspacePath
} from './projects'

void test('normalizeProjectState keeps existing directories and selects the newest project', () => {
  const root = mkdtempSync(join(tmpdir(), 'joker-projects-'))
  const first = join(root, 'first')
  const second = join(root, 'second')
  mkdirSync(first)
  mkdirSync(second)
  try {
    const state = normalizeProjectState({
      projects: [
        { id: 'project-first', name: 'first', path: first, lastUsedAt: 1 },
        { id: 'project-second', name: 'second', path: second, lastUsedAt: 2 },
        { id: 'bad', name: 'missing', path: join(root, 'missing'), lastUsedAt: 3 }
      ],
      activeProjectId: 'bad'
    })
    assert.deepEqual(state.projects.map((project) => project.name), [basename(second), basename(first)])
    assert.equal(state.activeProjectId, 'project-second')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

void test('normalizeProjectState keeps an empty list empty', () => {
  assert.deepEqual(normalizeProjectState({ projects: [], activeProjectId: null }), { projects: [], activeProjectId: null })
})

void test('canonicalizeProjectPath rejects files and missing paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'joker-projects-'))
  const file = join(root, 'file.txt')
  writeFileSync(file, 'x')
  try {
    assert.equal(canonicalizeProjectPath(file), null)
    assert.equal(canonicalizeProjectPath(join(root, 'missing')), null)
    assert.equal(canonicalizeProjectPath(root), root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

void test('resolveWorkspacePath rejects existing and missing symlink escapes', () => {
  const root = mkdtempSync(join(tmpdir(), 'joker-boundary-'))
  const outside = mkdtempSync(join(tmpdir(), 'joker-outside-'))
  const link = join(root, 'linked')
  mkdirSync(join(outside, 'nested'))
  symlinkSync(outside, link, 'junction')
  try {
    assert.throws(() => resolveWorkspacePath(root, 'linked/secret.txt', true), /outside workspace/)
    assert.throws(() => resolveWorkspacePath(root, 'linked/nested/secret.txt', true), /outside workspace/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
void test('isPathInsideWorkspace does not accept sibling prefixes', () => {
  const root = mkdtempSync(join(tmpdir(), 'joker-workspace-'))
  const sibling = `${root}-other`
  mkdirSync(sibling)
  try {
    assert.equal(isPathInsideWorkspace(root, join(root, 'src')), true)
    assert.equal(isPathInsideWorkspace(root, sibling), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(sibling, { recursive: true, force: true })
  }
})
