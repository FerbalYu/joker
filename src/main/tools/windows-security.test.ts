import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isPathInsideWorkspace,
  resolveWorkspacePath
} from '../store/projects'
import { validatePublicUrl } from './url-policy'
import { bashTool } from './bash'
import type { ToolContext } from './registry'

const bashContext = (): ToolContext => ({
  workspacePath: process.cwd(),
  sessionId: 'win-sec-test',
  approvalGate: async () => ({ outcome: 'allow', risk: 'read', reason: 'test approval' })
})

test('Windows: isPathInsideWorkspace rejects drive-letter sibling prefix confusion', () => {
  const root = mkdtempSync(join(tmpdir(), 'joker-winprefix-'))
  const sibling = `${root}Extra`
  mkdirSync(sibling)
  try {
    assert.equal(isPathInsideWorkspace(root, join(root, 'src')), true)
    assert.equal(isPathInsideWorkspace(root, sibling), false, 'sibling with longer name must not match')
    assert.equal(isPathInsideWorkspace(root, `${root}x`), false, 'single-char suffix sibling must not match')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(sibling, { recursive: true, force: true })
  }
})

test('Windows: isPathInsideWorkspace is case-insensitive on drive letters', () => {
  const root = mkdtempSync(join(tmpdir(), 'joker-wincase-'))
  try {
    const upperDrive = root.toUpperCase()
    const lowerDrive = root.toLowerCase()
    assert.equal(isPathInsideWorkspace(upperDrive, join(lowerDrive, 'src')), true)
    assert.equal(isPathInsideWorkspace(lowerDrive, join(upperDrive, 'src')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Windows: resolveWorkspacePath rejects backslash traversal attempts', () => {
  const root = mkdtempSync(join(tmpdir(), 'joker-wintraversal-'))
  const outside = mkdtempSync(join(tmpdir(), 'joker-winoutside-'))
  writeFileSync(join(outside, 'secret.txt'), 'secret')
  try {
    assert.throws(() => resolveWorkspacePath(root, '..\\..\\secret.txt'), /outside workspace|does not exist/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('Windows: url-policy rejects URLs with encoded backslashes in hostname', () => {
  assert.throws(() => validatePublicUrl('http://example%5C.com/'), /Invalid URL|Only http/)
  assert.throws(() => validatePublicUrl('http://127.0.0.1%5Cevil.com/'), /Invalid URL|Only http/)
})

test('Windows: url-policy rejects file URIs', () => {
  assert.throws(() => validatePublicUrl('file:///C:/Windows/System32/hosts'), /Only http/)
  assert.throws(() => validatePublicUrl('file://localhost/etc/passwd'), /Only http/)
})

test('Windows: Bash does not leak credential environment variables', async () => {
  const oldEnv = { ...process.env }
  process.env.OPENAI_API_KEY = 'sk-test-do-not-leak-1234567890'
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-do-not-leak'
  process.env.MY_SECRET_TOKEN = 'secret-token-value'
  try {
    const result = await bashTool.execute(
      { command: process.platform === 'win32' ? 'set' : 'env' },
      bashContext()
    )
    const output = result.output
    assert.ok(!output.includes('sk-test-do-not-leak'), 'OPENAI_API_KEY value must not appear in Bash output')
    assert.ok(!output.includes('sk-ant-test-do-not-leak'), 'ANTHROPIC_API_KEY value must not appear in Bash output')
    assert.ok(!output.includes('secret-token-value'), 'custom secret token must not appear in Bash output')
    assert.ok(!output.includes('OPENAI_API_KEY='), 'OPENAI_API_KEY variable name must not appear')
    assert.ok(!output.includes('ANTHROPIC_API_KEY='), 'ANTHROPIC_API_KEY variable name must not appear')
    assert.ok(!output.includes('MY_SECRET_TOKEN='), 'custom secret variable name must not appear')
  } finally {
    process.env = oldEnv
  }
})
