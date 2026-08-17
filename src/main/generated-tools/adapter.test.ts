import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildGeneratedToolDefinitions, initializeGeneratedToolRuntime, listGeneratedToolSnapshotBindings } from './adapter'
import { installSummarizeTaskJsonFixture } from './fixture'
import { installRuntimeQualificationFixture } from './test-fixtures'
import { readGeneratedToolInvocations } from './invocation-store'
import { disableGeneratedTool, readGeneratedToolRegistry } from './registry'
import { buildToolSet } from '../tools/registry'

void test('fixture installs immutable v1 and executes through the production QuickJS adapter', async () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-generated-adapter-'))
  const workspace = join(home, 'workspace')
  try {
    mkdirSync(join(workspace, 'fixtures'), { recursive: true })
    writeFileSync(join(workspace, 'fixtures', 'tasks.json'), JSON.stringify([
      { status: 'open' }, { status: 'done' }, { status: 'open' }
    ]))
    installRuntimeQualificationFixture(home)
    installSummarizeTaskJsonFixture(home, 1)
    const bindings = listGeneratedToolSnapshotBindings({ jokerHome: home, projectId: 'qualification-p0' })
    assert.deepEqual(bindings.map(({ toolId, versionId, validationReportId, pointerRevision, capabilityRevision, runtimeQualificationLevel, validationProfile, projectId }) => ({ toolId, versionId, validationReportId, pointerRevision, capabilityRevision, runtimeQualificationLevel, validationProfile, projectId })), [
      {
        toolId: 'summarize-task-json',
        versionId: 'v1',
        validationReportId: 'summarize-task-json-v1-report',
        pointerRevision: 1,
        capabilityRevision: 1,
        runtimeQualificationLevel: 'L2', validationProfile: 'user-owned-full-trust-v1',
        projectId: 'qualification-p0'
      }
    ])
    assert.deepEqual(initializeGeneratedToolRuntime(), {
      protocolVersion: 1,
      runtime: 'quickjs-wasm',
      methods: ['initialize', 'tools/list', 'tools/call']
    })
    const definitions = buildGeneratedToolDefinitions(workspace, home, bindings, new Set(), 'qualification-p0')
    assert.equal(definitions.length, 1)
    assert.deepEqual(definitions[0].source, {
      type: 'generated',
      toolId: 'summarize-task-json',
      name: 'SummarizeTaskJson',
      versionId: 'v1',
      fingerprint: bindings[0].fingerprint,
      validationReportId: 'summarize-task-json-v1-report',
      pointerRevision: 1,
      capabilityRevision: 1,
      runtimeQualificationLevel: 'L2', validationProfile: 'user-owned-full-trust-v1'
    })
    const toolSet = buildToolSet(definitions, {
      workspacePath: workspace,
      sessionId: 'session-1',
      runId: 'run-1',
      approvalGate: async () => ({ outcome: 'allow', risk: 'read', reason: 'test' })
    })
    const result = await (toolSet['summarize-task-json'] as unknown as {
      execute: (input: Record<string, unknown>, options: { toolCallId: string }) => Promise<{ output: string; metadata?: Record<string, unknown> }>
    }).execute({}, { toolCallId: 'call-1' })
    assert.equal(result.output, 'open: 2\ndone: 1')
    const generatedMetadata = result.metadata?.['generatedTool'] as { versionId?: string; manifestHash?: string }
    assert.equal(generatedMetadata.versionId, 'v1')
    assert.equal(generatedMetadata.manifestHash, installSummarizeTaskJsonFixture(home, 2).manifestHash)
    assert.equal((result.metadata?.['generatedTool'] as { pointerRevision?: number }).pointerRevision, 1)
    const invocation = readGeneratedToolInvocations(home).invocations[0]
    assert.equal(invocation.toolCallId, 'call-1')
    assert.equal(invocation.status, 'finished')
    assert.equal(invocation.outcome, 'succeeded')
    assert.equal(invocation.outputHash?.length, 64)
    assert.equal(readGeneratedToolRegistry(home).revision, 2)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('old generated snapshot fails closed after disable', async () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-generated-adapter-'))
  const workspace = join(home, 'workspace')
  try {
    mkdirSync(join(workspace, 'fixtures'), { recursive: true })
    writeFileSync(join(workspace, 'fixtures', 'tasks.json'), '[]')
    installRuntimeQualificationFixture(home)
    installSummarizeTaskJsonFixture(home, 1)
    const bindings = listGeneratedToolSnapshotBindings({ jokerHome: home, projectId: 'qualification-p0' })
    const [definition] = buildGeneratedToolDefinitions(workspace, home, bindings, new Set(), 'qualification-p0')
    const registry = readGeneratedToolRegistry(home)
    disableGeneratedTool({ jokerHome: home, registryId: registry.registryId, expectedRevision: registry.revision, operationId: 'disable-fixture', createdAt: 2, toolId: 'summarize-task-json' })
    await assert.rejects(() => definition.execute({}, {
      workspacePath: workspace,
      sessionId: 'session-1',
      approvalGate: async () => ({ outcome: 'allow', risk: 'read', reason: 'test' })
    }), /no longer active/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('old snapshot stays revoked after the same version is re-promoted', async () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-generated-adapter-'))
  const workspace = join(home, 'workspace')
  try {
    mkdirSync(join(workspace, 'fixtures'), { recursive: true })
    writeFileSync(join(workspace, 'fixtures', 'tasks.json'), '[]')
    installRuntimeQualificationFixture(home)
    installSummarizeTaskJsonFixture(home, 1)
    const bindings = listGeneratedToolSnapshotBindings({ jokerHome: home, projectId: 'qualification-p0' })
    const [definition] = buildGeneratedToolDefinitions(workspace, home, bindings, new Set(), 'qualification-p0')
    const registry = readGeneratedToolRegistry(home)
    disableGeneratedTool({ jokerHome: home, registryId: registry.registryId, expectedRevision: registry.revision, operationId: 'disable-revoked-snapshot', createdAt: 2, toolId: 'summarize-task-json' })
    installSummarizeTaskJsonFixture(home, 3)
    await assert.rejects(() => definition.execute({}, {
      workspacePath: workspace,
      sessionId: 'session-old-snapshot',
      approvalGate: async () => ({ outcome: 'allow', risk: 'read', reason: 'test' })
    }), /no longer active/)
    const refreshed = buildGeneratedToolDefinitions(
      workspace,
      home,
      listGeneratedToolSnapshotBindings({ jokerHome: home, projectId: 'qualification-p0' }),
      new Set(),
      'qualification-p0'
    )
    assert.equal((await refreshed[0].execute({}, {
      workspacePath: workspace,
      sessionId: 'session-new-snapshot',
      approvalGate: async () => ({ outcome: 'allow', risk: 'read', reason: 'test' })
    })).output, '')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('fixture bootstrap re-promotes a registered v1 after disable', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-generated-adapter-'))
  try {
    installRuntimeQualificationFixture(home)
    installSummarizeTaskJsonFixture(home, 1)
    const registry = readGeneratedToolRegistry(home)
    disableGeneratedTool({
      jokerHome: home,
      registryId: registry.registryId,
      expectedRevision: registry.revision,
      operationId: 'disable-before-bootstrap',
      createdAt: 2,
      toolId: 'summarize-task-json'
    })
    installSummarizeTaskJsonFixture(home, 3)
    const recovered = readGeneratedToolRegistry(home)
    assert.equal(recovered.entries[0]?.descriptor.availability, 'available')
    assert.equal(recovered.activePointers[0]?.activeVersionId, 'v1')
    assert.equal(recovered.capabilityRevision.revision, 3)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('generated tools are visible regardless of project scope', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-generated-adapter-'))
  try {
    installRuntimeQualificationFixture(home)
    installSummarizeTaskJsonFixture(home, 1)
    assert.equal(listGeneratedToolSnapshotBindings({ jokerHome: home, projectId: 'other-project' }).length, 1)
    assert.equal(listGeneratedToolSnapshotBindings({ jokerHome: home, projectId: 'qualification-p0' }).length, 1)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('generated calls bypass the ambient approval gate', async () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-generated-adapter-'))
  const workspace = join(home, 'workspace')
  try {
    mkdirSync(join(workspace, 'fixtures'), { recursive: true })
    writeFileSync(join(workspace, 'fixtures', 'tasks.json'), '[]')
    installRuntimeQualificationFixture(home)
    installSummarizeTaskJsonFixture(home, 1)
    const definitions = buildGeneratedToolDefinitions(
      workspace,
      home,
      listGeneratedToolSnapshotBindings({ jokerHome: home, projectId: 'qualification-p0' }),
      new Set(),
      'qualification-p0'
    )
    const toolSet = buildToolSet(definitions, {
      workspacePath: workspace,
      sessionId: 'session-auto',
      runId: 'run-auto',
      approvalGate: async () => { throw new Error('ambient gate must not be used') }
    })
    const result = await (toolSet['summarize-task-json'] as unknown as {
      execute: (input: Record<string, unknown>, options: { toolCallId: string }) => Promise<{ output: string }>
    }).execute({}, { toolCallId: 'call-auto' })
    assert.equal(result.output, '')
    const invocation = readGeneratedToolInvocations(home).invocations[0]
    assert.equal(invocation.status, 'finished')
    assert.equal(invocation.policyDecision, 'allow')
    assert.equal(invocation.outcome, 'succeeded')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('generated tools are visible without runtime qualification', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-generated-adapter-'))
  try {
    installSummarizeTaskJsonFixture(home, 1)
    assert.equal(listGeneratedToolSnapshotBindings({ jokerHome: home, projectId: 'qualification-p0' }).length, 1)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('generated tool bindings report the ungated L2 qualification level', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-generated-adapter-'))
  try {
    installRuntimeQualificationFixture(home, 'L1')
    installSummarizeTaskJsonFixture(home, 1)
    const [binding] = listGeneratedToolSnapshotBindings({ jokerHome: home, projectId: 'qualification-p0' })
    assert.equal(binding.runtimeQualificationLevel, 'L2')
    const [definition] = buildGeneratedToolDefinitions(process.cwd(), home, [binding], new Set(), 'qualification-p0')
    assert.equal(definition.source?.type, 'generated')
    if (definition.source?.type === 'generated') assert.equal(definition.source.runtimeQualificationLevel, 'L2')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('generated tool names cannot shadow builtin capabilities', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-generated-adapter-'))
  const workspace = join(home, 'workspace')
  try {
    installRuntimeQualificationFixture(home)
    installSummarizeTaskJsonFixture(home, 1)
    assert.throws(() => buildGeneratedToolDefinitions(
      workspace,
      home,
      listGeneratedToolSnapshotBindings({ jokerHome: home, projectId: 'qualification-p0' }),
      new Set(['SUMMARIZE-TASK-JSON']),
      'qualification-p0'
    ), /conflicts/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
