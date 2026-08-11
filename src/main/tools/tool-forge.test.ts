import { createHash } from 'node:crypto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { canonicalGeneratedToolJson } from '../../shared/generated-tools-schema'
import { createForgeJob } from '../generated-tools/forge-job-store'
import { installRuntimeQualificationFixture } from '../generated-tools/test-fixtures'
import { registerGeneratedToolValidationSuite } from '../generated-tools/validation-suite'
import { buildToolForgeMetaTools } from './tool-forge'
import { normalizeConfig, setToolForgeFullTrust } from '../store/config'
import { searchTools } from './tool-search'

void test('ToolSearch reports exact builtin and in-progress ForgeJob capabilities deterministically', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-tool-search-'))
  try {
    const spec = {
      id: 'candidate-tool', displayName: 'CandidateTool', goal: 'Summarize candidate files', reason: 'Missing capability',
      requestedBy: { sessionId: 'session-1', runId: 'run-1', userMessageId: 'message-1' }, scope: 'project' as const, projectId: 'project-1',
      inputContract: {}, outputContract: { type: 'string' },
      permissions: { filesystem: { read: [], write: [] }, network: { hosts: [] }, process: { commands: [] }, environment: { keys: [] }, secrets: { handles: [] } },
      acceptance: ['works'], examples: [{ input: {}, expected: 'ok' }]
    }
    createForgeJob(home, {
      id: 'job-search', idempotencyKey: 'idem-search',
      specHash: createHash('sha256').update(canonicalGeneratedToolJson(spec)).digest('hex'),
      toolId: spec.id, mode: 'create', status: 'queued', revision: 0, spec, attempt: 1, maxAttempts: 3,
      createdAt: 1, updatedAt: 1, artifactPath: 'jobs/job-search/workspace'
    })
    assert.equal(searchTools('Read', { jokerHome: home, builtinTools: [{ name: 'Read', description: 'Read project files' }] })[0]?.match, 'exact')
    const building = searchTools('candidate-tool', { jokerHome: home })[0]
    assert.equal(building?.match, 'building')
    assert.equal(building?.jobId, 'job-search')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('ToolForge exposes only search and start to the agent', () => {
  const tools = buildToolForgeMetaTools({ jokerHome: 'E:/unused-toolforge-home' })
  assert.deepEqual(tools.map((tool) => tool.name), ['ToolSearch', 'ToolForgeStart'])
})

void test('ToolForgeStart accepts unrestricted profiles and generic validation plans', async () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-tool-forge-blocked-'))
  try {
    installRuntimeQualificationFixture(home, 'L1')
    const controller = {
      enqueue: () => true,
      cancel: async () => { throw new Error('not used') }
    }
    const tools = buildToolForgeMetaTools({ jokerHome: home, controller })
    const start = tools.find((item) => item.name === 'ToolForgeStart')!
    const baseSpec = {
      id: 'unsupported-memory-tool', displayName: 'UnsupportedMemoryTool', goal: 'Persist project memory', reason: 'Missing capability',
      requestedBy: { sessionId: 'session-1', runId: 'run-1', userMessageId: 'message-1' }, scope: 'project' as const, projectId: 'project-1',
      inputContract: { type: 'object', additionalProperties: false }, outputContract: { type: 'string' },
      permissions: { filesystem: { read: [], write: ['.joker/project-memory'] }, network: { hosts: [] }, process: { commands: [] }, environment: { keys: [] }, secrets: { handles: [] } },
      acceptance: ['works'], examples: [{ input: {}, expected: 'ok' }]
    }
    const context = { workspacePath: null, sessionId: 'session-1', approvalGate: async () => ({ outcome: 'allow' as const, risk: 'write_local' as const, reason: 'test' }) }
    const unrestricted = JSON.parse((await start.execute({ idempotencyKey: 'blocked-write', mode: 'create', maxAttempts: 3, spec: baseSpec }, context)).output)
    assert.equal(unrestricted.status, 'queued')
    assert.equal(searchTools(baseSpec.id, { jokerHome: home })[0]?.match, 'building')

    const genericPlan = JSON.parse((await start.execute({
      idempotencyKey: 'generic-plan', mode: 'create', maxAttempts: 3,
      spec: {
        ...baseSpec,
        id: 'generic-plan-tool',
        permissions: { ...baseSpec.permissions, filesystem: { read: [], write: [] } },
        validationCases: [
          { id: 'success', input: {}, workspaceFiles: {}, expected: { outcome: 'succeeded', output: 'ok' } },
          { id: 'failure', input: { fail: true }, workspaceFiles: {}, expected: { outcome: 'tool-failed', error: { message: 'expected-failure' } } }
        ]
      }
    }, context)).output)
    assert.equal(genericPlan.status, 'queued')
    assert.equal(searchTools('generic-plan-tool', { jokerHome: home })[0]?.match, 'building')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('ToolForgeStart accepts a full-trust Memory Tool only for the active granted workspace', async () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-tool-forge-full-trust-'))
  const workspace = join(home, 'workspace')
  try {
    mkdirSync(workspace, { recursive: true })
    installRuntimeQualificationFixture(home, 'L1')
    const controller = {
      enqueue: () => true,
      cancel: async () => { throw new Error('not used') }
    }
    const config = setToolForgeFullTrust(normalizeConfig({}), workspace, true)
    const projectId = 'project-full-trust'
    const start = buildToolForgeMetaTools({
      jokerHome: home,
      controller,
      loadConfig: () => config,
      resolveProjectPath: (id) => id === projectId ? workspace : null
    }).find((item) => item.name === 'ToolForgeStart')!
    const spec = {
      id: 'persistent-project-memory',
      displayName: 'PersistentProjectMemory',
      goal: 'Persist project memory in the reserved memory file.',
      reason: 'Project memory capability is missing',
      requestedBy: { sessionId: 'session-1', runId: 'run-1', userMessageId: 'message-1' },
      scope: 'project' as const,
      projectId,
      validationProfile: 'user-owned-full-trust-v1' as const,
      inputContract: { type: 'object', additionalProperties: false },
      outputContract: { type: 'object', additionalProperties: false },
      permissions: {
        filesystem: { read: [], write: ['.project-memory/MEMORY.md'] },
        network: { hosts: [] },
        process: { commands: [] },
        environment: { keys: [] },
        secrets: { handles: [] }
      },
      acceptance: ['Writes the declared project memory file and reports success.'],
      examples: [{ input: {}, expected: 'unused legacy example' }],
      validationCases: [
        { id: 'success', input: { value: 'remembered' }, workspaceFiles: {}, expected: { outcome: 'succeeded', output: { saved: true } } },
        { id: 'failure', input: { fail: true }, workspaceFiles: {}, expected: { outcome: 'tool-failed', error: { message: 'expected-failure' } } }
      ]
    }
    const context = {
      workspacePath: workspace,
      sessionId: 'session-1',
      runId: 'run-1',
      approvalGate: async () => ({ outcome: 'allow' as const, risk: 'write_local' as const, reason: 'test' })
    }
    const result = JSON.parse((await start.execute({ idempotencyKey: 'full-trust-memory', mode: 'create', maxAttempts: 1, spec }, context)).output)
    assert.equal(result.status, 'queued')
    assert.equal(result.toolId, spec.id)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

void test('ToolForgeStart fails a durable job when enqueue is rejected', async () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-tool-forge-enqueue-'))
  try {
    installRuntimeQualificationFixture(home, 'L1')
    registerGeneratedToolValidationSuite({
      id: 'enqueue-rejected-tool-v1',
      toolId: 'enqueue-rejected-tool',
      cases: [
        { id: 'success', input: {}, workspaceFiles: {}, expected: { outcome: 'succeeded', output: 'ok' } },
        { id: 'failure', input: { fail: true }, workspaceFiles: {}, expected: { outcome: 'tool-failed', error: { message: 'expected-failure' } } }
      ]
    })
    const controller = { enqueue: () => false, cancel: async () => { throw new Error('not used') } }
    const start = buildToolForgeMetaTools({ jokerHome: home, controller, createId: () => 'enqueue-job', now: () => 7 }).find((item) => item.name === 'ToolForgeStart')!
    const spec = {
      id: 'enqueue-rejected-tool', displayName: 'EnqueueRejectedTool', goal: 'Return ok', reason: 'Missing capability',
      requestedBy: { sessionId: 'session-1', runId: 'run-1', userMessageId: 'message-1' }, scope: 'project' as const, projectId: 'project-1',
      inputContract: { type: 'object', additionalProperties: false }, outputContract: { type: 'string' },
      permissions: { filesystem: { read: [], write: [] }, network: { hosts: [] }, process: { commands: [] }, environment: { keys: [] }, secrets: { handles: [] } },
      acceptance: ['works'], examples: [{ input: {}, expected: 'ok' }]
    }
    const context = { workspacePath: null, sessionId: 'session-1', approvalGate: async () => ({ outcome: 'allow' as const, risk: 'write_local' as const, reason: 'test' }) }
    const result = JSON.parse((await start.execute({ idempotencyKey: 'enqueue-failed', mode: 'create', maxAttempts: 3, spec }, context)).output)
    assert.equal(result.status, 'failed')
    assert.equal(result.currentPhase, 'enqueue-failed')
    assert.equal(result.error, 'ToolForge service rejected the queued ForgeJob')
  } finally { rmSync(home, { recursive: true, force: true }) }
})
void test('ToolForgeStart creates and enqueues durable work without claiming task completion', async () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-tool-forge-'))
  try {
    installRuntimeQualificationFixture(home, 'L1')
    registerGeneratedToolValidationSuite({
      id: 'new-tool-test-v1',
      toolId: 'new-tool',
      cases: [
        { id: 'success', input: {}, workspaceFiles: {}, expected: { outcome: 'succeeded', output: 'ok' } },
        { id: 'failure', input: { fail: true }, workspaceFiles: {}, expected: { outcome: 'tool-failed', error: { message: 'expected-failure' } } }
      ]
    })
    const enqueued: string[] = []
    const controller = {
      enqueue: (jobId: string) => { enqueued.push(jobId); return true },
      cancel: async () => { throw new Error('not exposed to the agent') }
    }
    const tools = buildToolForgeMetaTools({ jokerHome: home, now: () => 5, createId: () => 'job-1', controller })
    const start = tools.find((item) => item.name === 'ToolForgeStart')!
    const spec = {
      id: 'new-tool', displayName: 'NewTool', goal: 'Return ok', reason: 'Missing capability',
      requestedBy: { sessionId: 'session-1', runId: 'run-1', userMessageId: 'message-1' }, scope: 'project' as const, projectId: 'project-1',
      inputContract: { type: 'object', additionalProperties: false }, outputContract: { type: 'string' },
      permissions: { filesystem: { read: [], write: [] }, network: { hosts: [] }, process: { commands: [] }, environment: { keys: [] }, secrets: { handles: [] } },
      acceptance: ['works'], examples: [{ input: {}, expected: 'ok' }]
    }
    const context = { workspacePath: null, sessionId: 'session-1', approvalGate: async () => ({ outcome: 'allow' as const, risk: 'write_local' as const, reason: 'test' }) }
    const started = JSON.parse((await start.execute({ idempotencyKey: 'idem-new', mode: 'create', maxAttempts: 3, spec }, context)).output)
    assert.equal(started.status, 'queued')
    assert.deepEqual(enqueued, [started.jobId])
    assert.equal(started.originalTaskComplete, false)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
