import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installSummarizeTaskJsonFixture } from './fixture'
import { readGeneratedToolRegistry } from './registry'
import { generatedToolsRoot } from './store'
import { mutateGeneratedToolLifecycle } from './lifecycle-service'
import { listGeneratedToolsForManagement } from './management-read-model'
import { GeneratedToolRevalidateService } from './revalidate-service'
import { installRuntimeQualificationFixture } from './test-fixtures'

void test('revalidate verifies the host artifact and updates descriptor availability', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-lifecycle-revalidate-'))
  try {
    installRuntimeQualificationFixture(home)
    installSummarizeTaskJsonFixture(home, 1)
    const versionRoot = join(home, '.joker', 'generated-tools', 'tools', 'summarize-task-json', 'versions', 'v1')
    const sourcePath = join(versionRoot, 'source', 'tool.js')
    const originalSource = readFileSync(sourcePath, 'utf8')
    writeFileSync(sourcePath, `${originalSource}\n tampered`, 'utf8')

    const before = readGeneratedToolRegistry(home)
    const changed = mutateGeneratedToolLifecycle('revalidate', {
      toolId: 'summarize-task-json',
      expectedRevision: before.revision,
      operationId: 'revalidate-changed'
    }, home, () => 10)
    assert.equal(changed.success, true)
    assert.equal(changed.activeVersionId, 'v1')
    const afterChanged = readGeneratedToolRegistry(home)
    assert.equal(afterChanged.entries[0].descriptor.availability, 'changed')
    assert.equal(afterChanged.capabilityRevision.revision, before.capabilityRevision.revision + 1)

    writeFileSync(sourcePath, originalSource, 'utf8')
    const restored = mutateGeneratedToolLifecycle('revalidate', {
      toolId: 'summarize-task-json',
      expectedRevision: afterChanged.revision,
      operationId: 'revalidate-restored'
    }, home, () => 11)
    assert.equal(restored.success, true)
    const afterRestored = readGeneratedToolRegistry(home)
    assert.equal(afterRestored.entries[0].descriptor.availability, 'available')
    assert.equal(afterRestored.capabilityRevision.revision, afterChanged.capabilityRevision.revision + 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

void test('permission metadata tamper becomes changed and fails host revalidation', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-lifecycle-permission-tamper-'))
  try {
    installRuntimeQualificationFixture(home)
    installSummarizeTaskJsonFixture(home, 1)
    const artifactRoot = join(generatedToolsRoot(home), 'tools', 'summarize-task-json', 'versions', 'v1')
    const versionPath = join(artifactRoot, 'version.json')
    const version = JSON.parse(readFileSync(versionPath, 'utf8')) as Record<string, unknown>
    const manifest = structuredClone(version['manifest']) as Record<string, unknown>
    manifest['permissions'] = {
      filesystem: { read: ['fixtures/tasks.json', 'fixtures/private.json'], write: [] },
      network: { hosts: [] },
      process: { commands: [] },
      environment: { keys: [] },
      secrets: { handles: [] }
    }
    writeFileSync(versionPath, `${JSON.stringify({ ...version, manifest }, null, 2)}\n`, 'utf8')

    const listed = listGeneratedToolsForManagement(home)
    assert.equal(listed.success, true)
    if (listed.success) {
      assert.equal(listed.data.tools[0].availability, 'changed')
      assert.equal(listed.data.tools[0].executable, false)
    }

    const registry = readGeneratedToolRegistry(home)
    const revalidated = new GeneratedToolRevalidateService({ jokerHome: home, now: () => 2 }).revalidate({
      toolId: 'summarize-task-json',
      versionId: 'v1',
      expectedRevision: registry.revision,
      operationId: 'revalidate-permission-tamper'
    })
    assert.equal(revalidated.success, false)
    assert.deepEqual(readGeneratedToolRegistry(home), registry)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

void test('disable then remove quarantines the tool and restart readback keeps only quarantine', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-lifecycle-remove-'))
  try {
    installRuntimeQualificationFixture(home)
    installSummarizeTaskJsonFixture(home, 1)
    const toolDirectory = join(generatedToolsRoot(home), 'tools', 'summarize-task-json')
    const quarantineDirectory = join(generatedToolsRoot(home), 'quarantine', 'summarize-task-json-remove-disabled')
    const before = readGeneratedToolRegistry(home)
    const disabled = mutateGeneratedToolLifecycle('disable', {
      toolId: 'summarize-task-json',
      expectedRevision: before.revision,
      operationId: 'disable-before-remove'
    }, home, () => 2)
    assert.equal(disabled.success, true)

    const afterDisable = readGeneratedToolRegistry(home)
    const removed = mutateGeneratedToolLifecycle('remove', {
      toolId: 'summarize-task-json',
      expectedRevision: afterDisable.revision,
      operationId: 'remove-disabled'
    }, home, () => 3)
    assert.deepEqual(removed, {
      success: true,
      registryRevision: afterDisable.revision + 1,
      capabilityRevision: afterDisable.capabilityRevision.revision + 1,
      activeVersionId: undefined,
      quarantineId: 'summarize-task-json-remove-disabled'
    })
    assert.equal(existsSync(toolDirectory), false)
    assert.equal(existsSync(join(quarantineDirectory, 'versions', 'v1', 'version.json')), true)

    const afterRestart = readGeneratedToolRegistry(home)
    assert.equal(afterRestart.entries.some((entry) => entry.toolId === 'summarize-task-json'), false)
    assert.equal(afterRestart.activePointers.some((pointer) => pointer.toolId === 'summarize-task-json'), false)
    assert.equal(existsSync(quarantineDirectory), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

void test('remove rejects an active tool without moving its directory', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-lifecycle-remove-active-'))
  try {
    installRuntimeQualificationFixture(home)
    installSummarizeTaskJsonFixture(home, 1)
    const toolDirectory = join(generatedToolsRoot(home), 'tools', 'summarize-task-json')
    const quarantineDirectory = join(generatedToolsRoot(home), 'quarantine', 'summarize-task-json-remove-active')
    const before = readGeneratedToolRegistry(home)
    const removed = mutateGeneratedToolLifecycle('remove', {
      toolId: 'summarize-task-json',
      expectedRevision: before.revision,
      operationId: 'remove-active'
    }, home, () => 2)
    assert.equal(removed.success, false)
    assert.match(removed.error ?? '', /active version exists/)
    assert.equal(existsSync(toolDirectory), true)
    assert.equal(existsSync(quarantineDirectory), false)
    assert.deepEqual(readGeneratedToolRegistry(home), before)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

void test('remove CAS failure restores the quarantined directory and preserves registry state', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-lifecycle-remove-cas-'))
  try {
    installRuntimeQualificationFixture(home)
    installSummarizeTaskJsonFixture(home, 1)
    const active = readGeneratedToolRegistry(home)
    assert.equal(mutateGeneratedToolLifecycle('disable', {
      toolId: 'summarize-task-json',
      expectedRevision: active.revision,
      operationId: 'disable-before-stale-remove'
    }, home, () => 2).success, true)
    const beforeRemove = readGeneratedToolRegistry(home)
    const toolDirectory = join(generatedToolsRoot(home), 'tools', 'summarize-task-json')
    const quarantineDirectory = join(generatedToolsRoot(home), 'quarantine', 'summarize-task-json-remove-stale')
    const removed = mutateGeneratedToolLifecycle('remove', {
      toolId: 'summarize-task-json',
      expectedRevision: beforeRemove.revision - 1,
      operationId: 'remove-stale'
    }, home, () => 3)
    assert.equal(removed.success, false)
    assert.match(removed.error ?? '', /revision is stale/)
    assert.equal(existsSync(toolDirectory), true)
    assert.equal(existsSync(quarantineDirectory), false)
    assert.deepEqual(readGeneratedToolRegistry(home), beforeRemove)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

void test('remove fails closed when the quarantine destination conflicts', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-lifecycle-remove-conflict-'))
  try {
    installRuntimeQualificationFixture(home)
    installSummarizeTaskJsonFixture(home, 1)
    const active = readGeneratedToolRegistry(home)
    assert.equal(mutateGeneratedToolLifecycle('disable', {
      toolId: 'summarize-task-json',
      expectedRevision: active.revision,
      operationId: 'disable-before-conflict'
    }, home, () => 2).success, true)
    const beforeRemove = readGeneratedToolRegistry(home)
    const toolDirectory = join(generatedToolsRoot(home), 'tools', 'summarize-task-json')
    const quarantineDirectory = join(generatedToolsRoot(home), 'quarantine', 'summarize-task-json-remove-conflict')
    mkdirSync(quarantineDirectory, { recursive: true })
    writeFileSync(join(quarantineDirectory, 'sentinel.txt'), 'existing quarantine', 'utf8')

    const removed = mutateGeneratedToolLifecycle('remove', {
      toolId: 'summarize-task-json',
      expectedRevision: beforeRemove.revision,
      operationId: 'remove-conflict'
    }, home, () => 3)
    assert.equal(removed.success, false)
    assert.match(removed.error ?? '', /quarantine destination already conflicts/)
    assert.equal(existsSync(toolDirectory), true)
    assert.equal(readFileSync(join(quarantineDirectory, 'sentinel.txt'), 'utf8'), 'existing quarantine')
    assert.deepEqual(readGeneratedToolRegistry(home), beforeRemove)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

void test('lifecycle mutation results expose only renderer-safe identifiers', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-lifecycle-result-'))
  try {
    installRuntimeQualificationFixture(home)
    installSummarizeTaskJsonFixture(home, 1)
    const active = readGeneratedToolRegistry(home)
    assert.equal(mutateGeneratedToolLifecycle('disable', {
      toolId: 'summarize-task-json',
      expectedRevision: active.revision,
      operationId: 'disable-before-safe-result'
    }, home, () => 2).success, true)
    const disabled = readGeneratedToolRegistry(home)
    const result = mutateGeneratedToolLifecycle('remove', {
      toolId: 'summarize-task-json',
      expectedRevision: disabled.revision,
      operationId: 'remove-safe-result'
    }, home, () => 3)
    assert.equal(result.success, true)
    const serialized = JSON.stringify(result)
    assert.doesNotMatch(serialized, /artifactPath|quarantinePath|sourcePath|destinationPath/)
    assert.doesNotMatch(serialized, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.deepEqual(Object.keys(result).sort(), [
      'activeVersionId', 'capabilityRevision', 'quarantineId', 'registryRevision', 'success'
    ])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

void test('lifecycle service disables and rolls back with durable capability revisions', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-lifecycle-service-'))
  try {
    installRuntimeQualificationFixture(home)
    installSummarizeTaskJsonFixture(home, 1)
    const before = readGeneratedToolRegistry(home)
    const disabled = mutateGeneratedToolLifecycle('disable', { toolId: 'summarize-task-json', expectedRevision: before.revision, operationId: 'disable-service' }, home, () => 4)
    assert.equal(disabled.success, true)
    assert.equal(disabled.activeVersionId, undefined)
    const afterDisable = readGeneratedToolRegistry(home)
    assert.equal(afterDisable.capabilityRevision.revision, before.capabilityRevision.revision + 1)
    const rolledBack = mutateGeneratedToolLifecycle('rollback', { toolId: 'summarize-task-json', expectedRevision: afterDisable.revision, operationId: 'rollback-service', versionId: 'v1' }, home, () => 5)
    assert.equal(rolledBack.success, true)
    assert.equal(rolledBack.activeVersionId, 'v1')
    assert.equal(readGeneratedToolRegistry(home).capabilityRevision.revision, before.capabilityRevision.revision + 2)
    const disabledAgain = mutateGeneratedToolLifecycle('disable', { toolId: 'summarize-task-json', expectedRevision: readGeneratedToolRegistry(home).revision, operationId: 'disable-service-again' }, home, () => 6)
    assert.equal(disabledAgain.success, true)
    const reenabled = mutateGeneratedToolLifecycle('reenable', { toolId: 'summarize-task-json', expectedRevision: readGeneratedToolRegistry(home).revision, operationId: 'reenable-service', versionId: 'v1' }, home, () => 7)
    assert.equal(reenabled.success, true)
    assert.equal(reenabled.activeVersionId, 'v1')
    assert.equal(readGeneratedToolRegistry(home).capabilityRevision.revision, before.capabilityRevision.revision + 4)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
