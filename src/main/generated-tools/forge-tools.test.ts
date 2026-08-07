import { createHash } from 'node:crypto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ForgeJob } from '../../shared/generated-tools'
import { canonicalGeneratedToolJson } from '../../shared/generated-tools-schema'
import { createForgeJob, updateForgeJob } from './forge-job-store'
import { buildForgeAgentTools, getForgeAgentToolNames } from './forge-tools'

const spec: ForgeJob['spec'] = {
  id: 'forge-test-tool',
  displayName: 'ForgeTestTool',
  goal: 'Return deterministic text.',
  reason: 'Test ForgeAgent confinement.',
  requestedBy: { sessionId: 'session-1', runId: 'run-1', userMessageId: 'message-1' },
  scope: 'project',
  projectId: 'project-1',
  inputContract: {},
  outputContract: { type: 'string' },
  permissions: {
    filesystem: { read: [], write: [] },
    network: { hosts: [] },
    process: { commands: [] },
    environment: { keys: [] },
    secrets: { handles: [] }
  },
  acceptance: ['Returns ok.'],
  examples: [{ input: {}, expected: 'ok' }]
}

function setup(home: string): ForgeJob {
  const job: ForgeJob = {
    id: 'job-forge-tools',
    idempotencyKey: 'idem-forge-tools',
    specHash: createHash('sha256').update(canonicalGeneratedToolJson(spec)).digest('hex'),
    toolId: spec.id,
    mode: 'create',
    status: 'queued',
    revision: 0,
    spec,
    attempt: 1,
    maxAttempts: 3,
    createdAt: 1,
    updatedAt: 1,
    artifactPath: 'jobs/job-forge-tools/workspace'
  }
  createForgeJob(home, job)
  updateForgeJob(home, job.id, 0, (current) => ({ ...current, revision: 1, status: 'planning', startedAt: 2, updatedAt: 2 }))
  return updateForgeJob(home, job.id, 1, (current) => ({ ...current, revision: 2, status: 'building', updatedAt: 3 }))
}

function definition(home: string, name: string) {
  const tool = buildForgeAgentTools({
    jokerHome: home,
    jobId: 'job-forge-tools',
    validationSuiteId: 'forge-test-v1',
    validationSuiteHash: 'a'.repeat(64),
    now: () => 4,
    createValidationRunId: () => 'validation-run-1'
  }).find((item) => item.name === name)
  assert.ok(tool)
  return tool
}

const context = {
  workspacePath: null,
  sessionId: 'session-1',
  approvalGate: async () => ({ outcome: 'allow' as const, risk: 'write_local' as const, reason: 'test' })
}

void test('ForgeAgent tool allowlist excludes ambient capabilities', () => {
  assert.deepEqual(getForgeAgentToolNames(), [
    'ForgeReadSpec', 'ForgeListFiles', 'ForgeReadFile', 'ForgeWriteFile',
    'ForgeApplyPatch', 'ForgeRunCheck', 'ForgeReadCheckResult', 'ForgeSubmitCandidate'
  ])
  for (const denied of ['Read', 'Write', 'Edit', 'Bash', 'GitStatus', 'WebSearch', 'Agent', 'MCP', 'Promote']) {
    assert.equal(getForgeAgentToolNames().includes(denied), false)
  }
})

void test('Forge tools confine writes to the job workspace and enforce extensions', async () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-forge-tools-'))
  try {
    setup(home)
    const write = definition(home, 'ForgeWriteFile')
    await write.execute({ path: 'source/tool.js', content: 'tool.output("ok")\n' }, context)
    await assert.rejects(write.execute({ path: '../escape.js', content: 'bad' }, context), /Unsafe Forge path/)
    await assert.rejects(write.execute({ path: 'source/tool.exe', content: 'bad' }, context), /extension is not allowed/)
    const read = definition(home, 'ForgeReadFile')
    assert.equal((await read.execute({ path: 'source/tool.js' }, context)).output, 'tool.output("ok")\n')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('ForgeSubmitCandidate requires a host-owned passing check', async () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-forge-tools-'))
  try {
    setup(home)
    const submit = definition(home, 'ForgeSubmitCandidate')
    await assert.rejects(submit.execute({ expectedRevision: 2 }, context), /requires a passing host-owned structure check/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
