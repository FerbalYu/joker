import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { generateGate5AuditReport } from './gate5-audit'
import { getGate5MetricsPath, readGate5Metrics, recordGate5Metric, recordGate5Metrics } from './store/gate5-metrics'
import { GATE5_METRIC_IDS } from '../shared/gate5-metrics'

const SECTION23_IDS = [
  'real-task-gap-and-forge',
  'isolated-manufacturing',
  'independent-validation',
  'policy-promotion',
  'hot-toolset-refresh',
  'continuation-real-call',
  'conversation-settings-explainability',
  'targeted-natural-language-edit',
  'failed-edit-and-invalidation',
  'lifecycle-and-restart-recovery',
  'deterministic-security-and-race-tests'
]

function withAuditRoot(prefix: string, run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), prefix))
  try {
    mkdirSync(join(root, '.qa'), { recursive: true })
    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function writeArtifact(root: string, name: string, value: Record<string, unknown>): void {
  writeFileSync(join(root, '.qa', name), JSON.stringify(value), 'utf8')
}

void test('Gate 5 metrics use a host-owned durable canonical store', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-gate5-metrics-'))
  try {
    const first = recordGate5Metric('forge-job-created', 1, 100, home)
    const second = recordGate5Metrics({ 'manufacturing-duration-ms': 250, 'forge-job-created': 1 }, 200, home)
    assert.equal(first.metrics['forge-job-created'].count, 1)
    assert.equal(second.metrics['forge-job-created'].count, 2)
    assert.equal(second.metrics['manufacturing-duration-ms'].total, 250)
    assert.equal(second.revision, 3)
    assert.deepEqual(readGate5Metrics(home), second)
    assert.equal(JSON.parse(readFileSync(getGate5MetricsPath(home), 'utf8')).schemaVersion, 1)
    assert.equal(GATE5_METRIC_IDS.includes('continuation-duplicate-blocked'), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

void test('Gate 5 audit exposes exactly the 11 section 23 claims and every claim has multiple evidence groups', () => {
  withAuditRoot('joker-gate5-claims-', (root) => {
    const report = generateGate5AuditReport(root)
    assert.deepEqual(report.section23.map((claim) => claim.id), SECTION23_IDS)
    assert.equal(report.section23.length, 11)
    assert.equal(report.section23.every((claim) => claim.groups.length > 1), true)
    assert.equal(report.section23.every((claim) => claim.status === 'not-verified'), true)
    assert.equal(report.status, 'not-verified')
  })
})

void test('Gate 5 audit passes a complex claim only when every evidence group has a distinct retained passed direct check', () => {
  withAuditRoot('joker-gate5-groups-', (root) => {
    writeArtifact(root, 'complete-section23.json', {
      passed: true,
      checks: [
        { id: 'gap-discovery', pass: true },
        { id: 'toolforge-invocation', pass: true },
        { id: 'isolated-job-environment', pass: true },
        { id: 'workspace-boundary', pass: true },
        { id: 'independent-validator', pass: true },
        { id: 'behavior-validation', pass: true },
        { id: 'permission-validation', pass: true },
        { id: 'failure-validation', pass: true },
        { id: 'recovery-validation', pass: true },
        { id: 'low-risk-policy', pass: true },
        { id: 'promotion-result', pass: true },
        { id: 'no-restart-toolset-refresh', pass: true },
        { id: 'promoted-tool-active', pass: true },
        { id: 'continuation-resume', pass: true },
        { id: 'generated-tool-real-call', pass: true },
        { id: 'conversation-explainability', pass: true },
        { id: 'settings-explainability', pass: true },
        { id: 'purpose-state-explanation', pass: true },
        { id: 'permissions-evidence-explanation', pass: true },
        { id: 'targeted-tool-selection', pass: true },
        { id: 'natural-language-edit', pass: true },
        { id: 'failed-edit-preserves-stable', pass: true },
        { id: 'permission-change-invalidation', pass: true },
        { id: 'content-change-invalidation', pass: true },
        { id: 'lifecycle-deactivate', pass: true },
        { id: 'lifecycle-revalidate', pass: true },
        { id: 'lifecycle-rollback', pass: true },
        { id: 'lifecycle-delete', pass: true },
        { id: 'restart-recovery', pass: true },
        { id: 'security-overreach', pass: true },
        { id: 'fake-success', pass: true },
        { id: 'duplicate-continuation', pass: true },
        { id: 'concurrent-modification', pass: true },
        { id: 'half-switch', pass: true }
      ]
    })
    const report = generateGate5AuditReport(root)
    assert.equal(report.status, 'pass')
    assert.equal(report.section23.every((claim) => claim.status === 'pass'), true)
    for (const claim of report.section23) {
      assert.equal(claim.groups.every((group) => group.status === 'pass' && group.evidence.length === 1), true)
      assert.equal(claim.evidence.length, claim.groups.length)
      assert.equal(new Set(claim.evidence.flatMap((item) => item.checkIds)).size, claim.groups.length)
      for (const evidence of claim.evidence) {
        assert.equal(evidence.artifactPath, '.qa/complete-section23.json')
        assert.match(evidence.checksum, /^[a-f0-9]{64}$/)
        assert.equal(evidence.checkIds.length, 1)
        assert.ok(evidence.groupId)
      }
    }
  })
})

void test('Gate 5 audit does not accept top-level passed or one broad keyword check for a complex claim', () => {
  withAuditRoot('joker-gate5-broad-', (root) => {
    writeArtifact(root, 'broad.json', {
      passed: true,
      checks: [{
        id: 'all-section23-keywords',
        name: 'ToolSearch missing capability ToolForgeStart isolated workspace-boundary independent validation policy promotion ToolSet continuation conversation settings purpose permissions evidence targeted natural language edit rollback stable version invalidation restart recovery security fake-success duplicate continuation concurrency half-switch',
        pass: true
      }]
    })
    const report = generateGate5AuditReport(root)
    assert.equal(report.artifacts[0].status, 'pass')
    assert.equal(report.section23.some((claim) => claim.status === 'pass'), false)
    assert.equal(report.section23.every((claim) => claim.evidence.length <= 1), true)
    assert.equal(report.status, 'partial')
  })
})

void test('Gate 5 audit keeps absent subgroups partial and wholly absent claims not-verified', () => {
  withAuditRoot('joker-gate5-partial-', (root) => {
    writeArtifact(root, 'partial.json', {
      passed: true,
      checks: [
        { id: 'gap-discovery', pass: true },
        { id: 'failed-edit-preserves-stable', pass: false },
        { id: 'permission-change-invalidation', status: 'not-verified' }
      ]
    })
    const report = generateGate5AuditReport(root)
    const gapClaim = report.section23.find((claim) => claim.id === 'real-task-gap-and-forge')
    const invalidationClaim = report.section23.find((claim) => claim.id === 'failed-edit-and-invalidation')
    const lifecycleClaim = report.section23.find((claim) => claim.id === 'lifecycle-and-restart-recovery')
    assert.equal(gapClaim?.status, 'partial')
    assert.equal(gapClaim?.groups.find((group) => group.id === 'gap-discovery')?.status, 'pass')
    assert.equal(gapClaim?.groups.find((group) => group.id === 'toolforge-invocation')?.status, 'not-verified')
    assert.match(gapClaim?.note ?? '', /toolforge-invocation/)
    assert.equal(invalidationClaim?.status, 'not-verified')
    assert.equal(invalidationClaim?.evidence.length, 0)
    assert.equal(lifecycleClaim?.status, 'not-verified')
    assert.equal(report.status, 'partial')
  })
})

void test('Gate 5 audit ignores unrelated keywords nested in check details and scenario payloads', () => {
  withAuditRoot('joker-gate5-semantic-scope-', (root) => {
    writeArtifact(root, 'semantic-scope.json', {
      qualification: 'semantic-scope',
      passed: true,
      checks: [{
        name: 'Provider first selects ToolSearch for the real user task',
        pass: true,
        details: ['ToolSearch', 'ToolForgeStart', 'ToolPromote', 'generated-tool-call']
      }, {
        name: 'Fixture v1 is available',
        pass: true,
        details: {
          validatorReport: 'independent validation passed',
          recovery: 'restart recovery completed'
        }
      }],
      scenarios: [{
        scenario: 'gate2-happy-path',
        status: 'pass',
        toolOrder: ['ToolSearch', 'ToolForgeStart', 'ToolPromote'],
        policy: { decision: 'allow', reason: 'low risk policy' }
      }]
    })
    const report = generateGate5AuditReport(root)
    assert.equal(report.section23.find((claim) => claim.id === 'policy-promotion')?.status, 'not-verified')
    assert.equal(report.section23.find((claim) => claim.id === 'independent-validation')?.status, 'not-verified')
    assert.equal(report.section23.find((claim) => claim.id === 'continuation-real-call')?.status, 'not-verified')
  })
})

void test('Gate 5 runtime negative controls stay scoped away from authoritative QuickJS L2 status and section 23 evidence', () => {
  withAuditRoot('joker-gate5-runtime-', (root) => {
    mkdirSync(join(root, '.qa', 'runtime'), { recursive: true })
    writeFileSync(join(root, '.qa', 'runtime', 'runtime-qualification.json'), JSON.stringify({
      generatedAt: 1785972767010,
      level: 'L2',
      passed: false,
      environments: {
        dev: { status: 'passed' },
        packaged: { status: 'passed' }
      },
      candidates: [{
        candidate: 'quickjs-wasm',
        env: 'packaged',
        passesIsolation: true,
        cases: [
          { id: 'workspace-boundary', status: 'pass', details: 'undeclared file denied' },
          { id: 'legit-execution', status: 'pass', details: 'expected output' }
        ]
      }, {
        candidate: 'node-vm',
        env: 'dev',
        passesIsolation: false,
        cases: [
          { id: 'workspace-boundary', status: 'fail', details: 'escape observed' },
          { id: 'fake-success', status: 'pass', details: 'expected-negative control' }
        ]
      }, {
        candidate: 'child-process',
        env: 'dev',
        passesIsolation: false,
        cases: [
          { id: 'workspace-boundary', status: 'fail', details: 'escape observed' },
          { id: 'duplicate-continuation', status: 'pass', details: 'expected-negative control' }
        ]
      }]
    }), 'utf8')
    const report = generateGate5AuditReport(root)
    const artifact = report.artifacts[0]
    const isolated = report.section23.find((claim) => claim.id === 'isolated-manufacturing')
    const security = report.section23.find((claim) => claim.id === 'deterministic-security-and-race-tests')
    assert.equal(artifact.status, 'pass')
    assert.equal(artifact.checks, 2)
    assert.equal(isolated?.status, 'partial')
    assert.deepEqual(isolated?.evidence.flatMap((item) => item.checkIds), ['quickjs-wasm.packaged.workspace-boundary'])
    assert.equal(security?.status, 'partial')
    assert.deepEqual(security?.evidence.flatMap((item) => item.checkIds), ['quickjs-wasm.packaged.workspace-boundary'])
    assert.equal(report.section23.find((claim) => claim.id === 'real-task-gap-and-forge')?.status, 'not-verified')
    assert.equal(report.section23.flatMap((claim) => claim.evidence).some((item) => item.checkIds.some((id) => id.includes('node-vm') || id.includes('child-process'))), false)
  })
})
