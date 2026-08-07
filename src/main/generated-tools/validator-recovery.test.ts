import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ForgeJob } from '../../shared/generated-tools'
import { sealGeneratedToolCandidate } from './candidate-store'
import { createForgeJob, hashGeneratedToolSpec, readForgeJob, updateForgeJob } from './forge-job-store'
import { ForgeWorkspaceBroker } from './forge-workspace'
import { resumeAndValidateGeneratedToolCandidate } from './validator-recovery'
import { installRuntimeQualificationFixture } from './test-fixtures'
import {
  fingerprintGeneratedToolValidationSuite,
  registerGeneratedToolValidationSuite,
  type GeneratedToolValidationSuite
} from './validation-suite'

const suite: GeneratedToolValidationSuite = {
  id: 'validator-recovery-test-v1',
  toolId: 'validator-recovery-test-tool',
  cases: [
    { id: 'success', input: {}, workspaceFiles: {}, expected: { outcome: 'succeeded', output: 'ok' } },
    { id: 'failure', input: { fail: true }, workspaceFiles: {}, expected: { outcome: 'tool-failed', error: { message: 'expected-failure' } } }
  ]
}
registerGeneratedToolValidationSuite(suite)

void test('interrupted validation resumes the sealed candidate with a new run and reaches awaiting-policy', async () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-validator-recovery-'))
  try {
    installRuntimeQualificationFixture(home)
    const permissions = {
      filesystem: { read: [], write: [] }, network: { hosts: [] }, process: { commands: [] },
      environment: { keys: [] }, secrets: { handles: [] }
    }
    const manifest = {
      schemaVersion: 1 as const, toolId: suite.toolId, displayName: 'ValidatorRecoveryTestTool',
      description: 'Recovery fixture.', sdkVersion: '1.0.0', runtime: { id: 'quickjs-wasm' as const, version: '0.32.0' },
      entrypoint: 'dist/tool.js', inputSchema: { type: 'object' }, outputSchema: { type: 'string' },
      errorContract: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false },
      permissions, dependencies: [], limits: { timeoutMs: 500, maxInputBytes: 1024, maxOutputBytes: 4096, maxMemoryBytes: 32_000_000 }
    }
    const spec: ForgeJob['spec'] = {
      id: suite.toolId, displayName: manifest.displayName, goal: 'Recover validation', reason: 'Capability missing',
      requestedBy: { sessionId: 'session-1', runId: 'run-1', userMessageId: 'message-1' }, scope: 'project', projectId: 'project-1',
      inputContract: manifest.inputSchema, outputContract: manifest.outputSchema, permissions,
      acceptance: ['Pass after resume.'], examples: [{ input: {}, expected: 'ok' }]
    }
    const job = createForgeJob(home, {
      id: 'job-validator-recovery', idempotencyKey: 'idem-validator-recovery', specHash: hashGeneratedToolSpec(spec),
      toolId: spec.id, mode: 'create', status: 'queued', revision: 0, spec, attempt: 1, maxAttempts: 3,
      createdAt: 1, updatedAt: 1, artifactPath: 'jobs/job-validator-recovery/workspace'
    })
    const planning = updateForgeJob(home, job.id, job.revision, (current) => ({ ...current, revision: 1, status: 'planning', startedAt: 2, updatedAt: 2 }))
    const building = updateForgeJob(home, job.id, planning.revision, (current) => ({ ...current, revision: 2, status: 'building', updatedAt: 3 }))
    const broker = new ForgeWorkspaceBroker(home, job.id)
    const source = 'if (input.fail) tool.fail({message:"expected-failure"}); else tool.output("ok")'
    broker.writeFile('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`)
    broker.writeFile('source/tool.js', source)
    broker.writeFile('dist/tool.js', source)
    const validating = sealGeneratedToolCandidate({
      jokerHome: home, jobId: job.id, expectedRevision: building.revision,
      validationSuiteId: suite.id, validationSuiteHash: fingerprintGeneratedToolValidationSuite(suite),
      createdAt: 4, validationRunId: 'validation-before-restart'
    }).job
    const interrupted = updateForgeJob(home, job.id, validating.revision, (current) => ({
      ...current, revision: current.revision + 1, status: 'interrupted', updatedAt: 5, finishedAt: 5,
      error: 'recovered-after-restart', resumeHint: 'resume-from-validating'
    }))
    const result = await resumeAndValidateGeneratedToolCandidate(home, job.id, interrupted.revision)
    assert.equal(result.job.status, 'awaiting-policy')
    assert.notEqual(result.job.validationRunId, 'validation-before-restart')
    assert.equal(result.job.candidateId, validating.candidateId)
    assert.equal(readForgeJob(home, job.id)?.validationReportId, result.report?.id)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
