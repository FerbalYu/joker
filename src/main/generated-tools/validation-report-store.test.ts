import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { GeneratedToolValidationReport } from '../../shared/generated-tools'
import { ToolForgeCasError } from './registry'
import { readValidationReport, writeValidationReport, commitValidationReportBundle, getValidationReportBundlePath, verifyValidationReportBundle } from './validation-report-store'

const report: GeneratedToolValidationReport = {
  id: 'report-1', toolId: 'tool-1', versionId: 'version-1', artifactFingerprint: 'a'.repeat(64),
  startedAt: 1, finishedAt: 2, status: 'passed',
  checks: [{ id: 'schema', category: 'schema', status: 'passed', evidencePath: 'evidence/schema.json', message: 'ok' }],
  declaredPermissions: { filesystem: { read: [], write: [] }, network: { hosts: [] }, process: { commands: [] }, environment: { keys: [] }, secrets: { handles: [] } },
  observedCapabilities: [], logsPath: 'logs/validate.log'
}

void test('Gate 2 validation bundles bind content-addressed reports to evidence and logs', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-validation-report-'))
  try {
    const committed = commitValidationReportBundle({
      jokerHome: home,
      report: {
        toolId: 'tool-1', versionId: 'candidate-1', artifactFingerprint: 'a'.repeat(64),
        validationProfile: 'gate2-project-read-v1', jobId: 'job-1', attempt: 1,
        validationRunId: 'validation-1',
        validationPlanId: 'host-compiled-validation-plan-v1', validationPlanHash: 'b'.repeat(64),
        startedAt: 1, finishedAt: 2, status: 'failed',
        checks: [{ id: 'schema', category: 'schema', status: 'failed', evidencePath: 'evidence/schema.json', message: 'failed' }],
        declaredPermissions: report.declaredPermissions, observedCapabilities: []
      },
      evidence: [{ path: 'evidence/schema.json', bytes: '{"status":"failed"}\n' }],
      logs: '{"result":"failed"}\n'
    })
    assert.match(committed.id, /^validation-/)
    assert.deepEqual(verifyValidationReportBundle(home, committed.id), committed)
    const evidencePath = join(getValidationReportBundlePath(home, committed.id), 'evidence', 'schema.json')
    assert.equal(readFileSync(evidencePath, 'utf8'), '{"status":"failed"}\n')
    writeFileSync(evidencePath, '{"status":"passed"}\n', 'utf8')
    assert.throws(() => verifyValidationReportBundle(home, committed.id), /evidence changed/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('validation reports are immutable with exact idempotent replay', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-validation-report-'))
  try {
    assert.deepEqual(writeValidationReport(home, report), report)
    assert.deepEqual(writeValidationReport(home, report), report)
    assert.deepEqual(readValidationReport(home, report.id), report)
    assert.throws(() => writeValidationReport(home, { ...report, finishedAt: 3 }), ToolForgeCasError)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
