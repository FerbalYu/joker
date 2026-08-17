import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generatedToolExecutionGuard } from './execution-guard'
import { buildGeneratedToolDefinitions, listGeneratedToolSnapshotBindings } from './adapter'
import { installSummarizeTaskJsonFixture } from './fixture'
import { installRuntimeQualificationFixture } from './test-fixtures'
import { readGeneratedToolRegistry } from './registry'
import type { ToolContext, ToolDefinition } from '../tools/registry'

function makeFixture(): { home: string; workspace: string; definition: ToolDefinition; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'joker-generated-guard-'))
  const workspace = join(home, 'workspace')
  mkdirSync(join(workspace, 'fixtures'), { recursive: true })
  writeFileSync(join(workspace, 'fixtures', 'tasks.json'), '[]')
  installRuntimeQualificationFixture(home)
  installSummarizeTaskJsonFixture(home, 1)
  const bindings = listGeneratedToolSnapshotBindings({ jokerHome: home, projectId: 'qualification-p0' })
  const [definition] = buildGeneratedToolDefinitions(workspace, home, bindings, new Set(), 'qualification-p0')
  return { home, workspace, definition, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

function guardContext(definition: ToolDefinition, workspace: string, home: string) {
  const guard = generatedToolExecutionGuard(home, {
    readRegistry: () => readGeneratedToolRegistry(home)
  })
  return {
    guard,
    exec: {
      toolName: definition.name,
      input: {},
      definition,
      context: {
        workspacePath: workspace,
        sessionId: 'guard-test',
        approvalGate: async () => ({ outcome: 'allow' as const, risk: 'read' as const, reason: 'test' })
      } as ToolContext
    }
  }
}

void test('guard passes a consistent generated binding', () => {
  const { home, workspace, definition, cleanup } = makeFixture()
  try {
    const { guard, exec } = guardContext(definition, workspace, home)
    assert.equal(guard(exec), undefined)
  } finally { cleanup() }
})

void test('guard denies a fingerprint mismatch at the execution boundary', () => {
  const { home, workspace, definition, cleanup } = makeFixture()
  try {
    const stale = { ...definition, source: { ...(definition.source as object), fingerprint: 'f'.repeat(64) } } as ToolDefinition
    const { guard, exec } = guardContext(stale, workspace, home)
    assert.match(String(guard(exec)), /fingerprint mismatch/)
  } finally { cleanup() }
})

void test('guard denies a capability revision mismatch at the execution boundary', () => {
  const { home, workspace, definition, cleanup } = makeFixture()
  try {
    const stale = { ...definition, source: { ...(definition.source as object), capabilityRevision: 999 } } as ToolDefinition
    const { guard, exec } = guardContext(stale, workspace, home)
    assert.match(String(guard(exec)), /capability revision changed/)
  } finally { cleanup() }
})

void test('guard denies a pointer revision mismatch at the execution boundary', () => {
  const { home, workspace, definition, cleanup } = makeFixture()
  try {
    const stale = { ...definition, source: { ...(definition.source as object), pointerRevision: 999 } } as ToolDefinition
    const { guard, exec } = guardContext(stale, workspace, home)
    assert.match(String(guard(exec)), /pointer revision changed/)
  } finally { cleanup() }
})

void test('guard abstains for built-in tools', () => {
  const { workspace, cleanup } = makeFixture()
  try {
    const guard = generatedToolExecutionGuard('any')
    const builtin = {
      name: 'Read',
      description: 'read fixture',
      inputSchema: {} as never,
      execute: async () => ({ output: 'ok' })
    } as ToolDefinition
    assert.equal(guard({
      toolName: 'Read',
      input: {},
      definition: builtin,
      context: {
        workspacePath: workspace,
        sessionId: 's',
        approvalGate: async () => ({ outcome: 'allow' as const, risk: 'read' as const, reason: 'test' })
      } as ToolContext
    }), undefined)
  } finally { cleanup() }
})
