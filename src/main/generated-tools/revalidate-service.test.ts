import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GeneratedToolRevalidateService } from './revalidate-service'
import { installRuntimeQualificationFixture } from './test-fixtures'
import { installSummarizeTaskJsonFixture } from './fixture'
import { readGeneratedToolRegistry, disableGeneratedTool } from './registry'
import { generatedToolsRoot } from './store'

void test('revalidation verifies the immutable bundle and reactivates a disabled trusted version', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-revalidate-service-'))
  try {
    installRuntimeQualificationFixture(home)
    installSummarizeTaskJsonFixture(home, 1)
    let registry = readGeneratedToolRegistry(home)
    disableGeneratedTool({
      jokerHome: home,
      registryId: registry.registryId,
      expectedRevision: registry.revision,
      operationId: 'disable-before-revalidate',
      createdAt: 2,
      toolId: 'summarize-task-json'
    })
    registry = readGeneratedToolRegistry(home)
    const result = new GeneratedToolRevalidateService({ jokerHome: home, now: () => 3 }).revalidate({
      toolId: 'summarize-task-json',
      versionId: 'v1',
      expectedRevision: registry.revision,
      operationId: 'revalidate-v1'
    })
    assert.equal(result.success, true)
    if (result.success) {
      assert.equal(result.data.action, 'revalidated')
      assert.equal(result.data.activeVersionId, 'v1')
    }
    const active = readGeneratedToolRegistry(home).activePointers.find((item) => item.toolId === 'summarize-task-json')
    assert.equal(active?.activeVersionId, 'v1')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

void test('revalidation fails closed when published evidence is changed', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-revalidate-tampered-'))
  try {
    installRuntimeQualificationFixture(home)
    installSummarizeTaskJsonFixture(home, 1)
    const registry = readGeneratedToolRegistry(home)
    const evidence = join(generatedToolsRoot(home), 'tools', 'summarize-task-json', 'versions', 'v1', 'evidence', 'schema.json')
    writeFileSync(evidence, 'tampered', 'utf8')
    const result = new GeneratedToolRevalidateService({ jokerHome: home }).revalidate({
      toolId: 'summarize-task-json',
      versionId: 'v1',
      expectedRevision: registry.revision,
      operationId: 'revalidate-tampered'
    })
    assert.equal(result.success, false)
    assert.equal(readGeneratedToolRegistry(home).activePointers.find((item) => item.toolId === 'summarize-task-json')?.activeVersionId, 'v1')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

void test('revalidation is idempotent for an already active version', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-revalidate-idempotent-'))
  try {
    installRuntimeQualificationFixture(home)
    installSummarizeTaskJsonFixture(home, 1)
    const registry = readGeneratedToolRegistry(home)
    const result = new GeneratedToolRevalidateService({ jokerHome: home }).revalidate({
      toolId: 'summarize-task-json',
      versionId: 'v1',
      expectedRevision: registry.revision,
      operationId: 'revalidate-active'
    })
    assert.equal(result.success, true)
    if (result.success) assert.equal(result.data.action, 'already-active')
    assert.equal(readGeneratedToolRegistry(home).revision, registry.revision)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
