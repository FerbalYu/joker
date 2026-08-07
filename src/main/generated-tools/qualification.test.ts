import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  MANDATORY_QUALIFICATION_CASES,
  PACKAGED_EQUIVALENCE_CASE,
  deriveRuntimeLevel,
  getQualificationPath,
  qualificationCandidatePassesIsolation,
  qualificationReportFingerprint,
  readRuntimeQualificationReport,
  runtimeQualificationFileIdentity,
  writeRuntimeQualificationReport
} from './qualification'
import type {
  RuntimeQualificationCandidateResult,
  RuntimeQualificationEnvironmentResult,
  RuntimeQualificationReport
} from '../../shared/generated-tools'

function caseResult(
  id: string,
  status: 'pass' | 'fail' | 'inconclusive' | 'skipped' = 'pass',
  withEvidence = true
) {
  return {
    id: id as RuntimeQualificationReport['candidates'][number]['cases'][number]['id'],
    status,
    details: `case ${id}`,
    ...(withEvidence ? { evidence: { path: `evidence-${id}.json`, size: 1, sha256: '0'.repeat(64) } } : {})
  }
}

function qualifiedCandidate(
  env: 'dev' | 'packaged',
  candidate: RuntimeQualificationCandidateResult['candidate'] = 'quickjs-wasm'
): RuntimeQualificationCandidateResult {
  const cases = MANDATORY_QUALIFICATION_CASES.map((id) => ({
    ...caseResult(id),
    evidence: { path: `evidence-${env}-${id}.json`, size: 1, sha256: '0'.repeat(64) }
  }))
  if (env === 'packaged') cases.push({
    ...caseResult('packaged-equivalence'),
    evidence: { path: `evidence-${env}-packaged-equivalence.json`, size: 1, sha256: '0'.repeat(64) }
  })
  return { candidate, env, passesIsolation: true, cases }
}

function envResult(env: 'dev' | 'packaged', status: 'passed' | 'failed' | 'incomplete'): RuntimeQualificationEnvironmentResult {
  return { environment: env, status, startedAt: 1, finishedAt: 2 }
}

function writeEvidenceForReport(home: string, report: RuntimeQualificationReport): void {
  const root = dirname(getQualificationPath(home))
  report.artifactIdentity = writeArtifactIdentity(home)
  mkdirSync(root, { recursive: true })
  for (const candidate of report.candidates) {
    for (const item of candidate.cases) {
      if (!item.evidence) continue
      const path = join(root, item.evidence.path)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify({ candidate: candidate.candidate, env: candidate.env, id: item.id }), 'utf8')
      item.evidence = runtimeQualificationFileIdentity(path, root)
    }
  }
}

function writeArtifactIdentity(home: string, packaged = true): RuntimeQualificationReport['artifactIdentity'] {
  const root = dirname(getQualificationPath(home))
  const writeIdentity = (path: string, contents: string) => {
    const target = join(root, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, contents, 'utf8')
    return runtimeQualificationFileIdentity(target, root)
  }
  const bundle = writeIdentity('artifacts/out/main/index.js', 'bundle')
  const worker = writeIdentity('artifacts/out/main/generated-tool-worker.js', 'worker')
  const quickjsPackage = { ...writeIdentity('artifacts/quickjs/package.json', '{"version":"0.32.0"}'), version: '0.32.0' }
  const packageLock = writeIdentity('artifacts/package-lock.json', 'lock')
  return {
    bundle,
    worker,
    quickjsPackage,
    packageLock,
    ...(packaged ? {
      packaged: {
        executable: writeIdentity('artifacts/dist/JOKER.exe', 'executable'),
        appAsar: writeIdentity('artifacts/dist/resources/app.asar', 'asar')
      }
    } : {})
  }
}

function makeReport(overrides: {
  devStatus?: 'passed' | 'failed' | 'incomplete'
  packagedStatus?: 'passed' | 'failed' | 'incomplete'
  candidates?: RuntimeQualificationCandidateResult[]
  artifactIdentity?: RuntimeQualificationReport['artifactIdentity']
} = {}): RuntimeQualificationReport {
  return {
    schemaVersion: 2,
    generatedAt: 123,
    level: 'L0',
    artifactIdentity: overrides.artifactIdentity ?? {
      bundle: { path: 'artifacts/out/main/index.js', size: 1, sha256: '0'.repeat(64) },
      worker: { path: 'artifacts/out/main/generated-tool-worker.js', size: 1, sha256: '0'.repeat(64) },
      quickjsPackage: { path: 'artifacts/quickjs/package.json', size: 1, sha256: '0'.repeat(64), version: '0.32.0' },
      packageLock: { path: 'artifacts/package-lock.json', size: 1, sha256: '0'.repeat(64) },
      packaged: {
        executable: { path: 'artifacts/dist/JOKER.exe', size: 1, sha256: '0'.repeat(64) },
        appAsar: { path: 'artifacts/dist/resources/app.asar', size: 1, sha256: '0'.repeat(64) }
      }
    },
    environments: {
      dev: envResult('dev', overrides.devStatus ?? 'passed'),
      packaged: envResult('packaged', overrides.packagedStatus ?? 'passed')
    },
    candidates: overrides.candidates ?? [qualifiedCandidate('dev'), qualifiedCandidate('packaged')],
    limitations: []
  }
}

void test('mandatory qualification cases keep exact membership', () => {
  assert.deepEqual([...MANDATORY_QUALIFICATION_CASES], [
    'legit-execution',
    'workspace-boundary',
    'network-denied',
    'subprocess-denied',
    'env-denied',
    'timeout-cleanup',
    'cancel-cleanup',
    'ipc-registry-audit-isolation'
  ])
  assert.equal(PACKAGED_EQUIVALENCE_CASE, 'packaged-equivalence')
})

void test('deriveRuntimeLevel returns L2 when both environments qualify', () => {
  assert.equal(deriveRuntimeLevel(makeReport()), 'L2')
})

void test('deriveRuntimeLevel does not return L2 when different candidates qualify in each environment', () => {
  const candidates = [qualifiedCandidate('dev', 'quickjs-wasm'), qualifiedCandidate('packaged', 'node-vm')]
  assert.equal(deriveRuntimeLevel(makeReport({ candidates })), 'L1')
})

void test('deriveRuntimeLevel returns L1 when packaged env ran but did not qualify', () => {
  const candidates = [qualifiedCandidate('dev'), qualifiedCandidate('packaged')]
  candidates[1].cases[0] = { ...candidates[1].cases[0], status: 'fail', details: 'escaped' }
  assert.equal(deriveRuntimeLevel(makeReport({ candidates })), 'L1')
})

void test('deriveRuntimeLevel returns L1 when packaged env did not run', () => {
  assert.equal(deriveRuntimeLevel(makeReport({ packagedStatus: 'incomplete' })), 'L1')
})

void test('deriveRuntimeLevel returns L0 when dev env did not qualify', () => {
  const candidates = [qualifiedCandidate('dev'), qualifiedCandidate('packaged')]
  candidates[0].cases[0] = { ...candidates[0].cases[0], status: 'fail', details: 'escaped' }
  assert.equal(deriveRuntimeLevel(makeReport({ candidates })), 'L0')
})

void test('deriveRuntimeLevel returns L0 when dev env did not run', () => {
  assert.equal(deriveRuntimeLevel(makeReport({ devStatus: 'incomplete' })), 'L0')
})

void test('deriveRuntimeLevel does not count pass without evidence as a pass', () => {
  const candidates = [qualifiedCandidate('dev'), qualifiedCandidate('packaged')]
  candidates[0].cases = candidates[0].cases.map((c) => ({ ...c, evidence: undefined }))
  assert.equal(deriveRuntimeLevel(makeReport({ candidates })), 'L0')
})

void test('deriveRuntimeLevel does not qualify a candidate that reported an error', () => {
  const candidates = [qualifiedCandidate('dev'), qualifiedCandidate('packaged')]
  candidates[0].error = 'harness failed to load candidate'
  assert.equal(deriveRuntimeLevel(makeReport({ candidates })), 'L0')
})

void test('deriveRuntimeLevel does not qualify a candidate with zero mandatory cases', () => {
  const candidates = [
    { candidate: 'quickjs-wasm' as const, env: 'dev' as const, passesIsolation: true, cases: [] },
    qualifiedCandidate('packaged')
  ]
  assert.equal(deriveRuntimeLevel(makeReport({ candidates })), 'L0')
})

void test('deriveRuntimeLevel does not qualify a candidate missing one mandatory case', () => {
  const candidates = [qualifiedCandidate('dev'), qualifiedCandidate('packaged')]
  candidates[0].cases = candidates[0].cases.filter((c) => c.id !== 'network-denied')
  assert.equal(deriveRuntimeLevel(makeReport({ candidates })), 'L0')
})

void test('packaged candidate does not qualify without a passing packaged-equivalence case', () => {
  const packaged = qualifiedCandidate('packaged')
  packaged.cases = packaged.cases.filter((c) => c.id !== PACKAGED_EQUIVALENCE_CASE)
  assert.equal(qualificationCandidatePassesIsolation(packaged, 'packaged'), false)
  const packagedFail = qualifiedCandidate('packaged')
  const idx = packagedFail.cases.findIndex((c) => c.id === PACKAGED_EQUIVALENCE_CASE)
  packagedFail.cases[idx] = { ...packagedFail.cases[idx], status: 'fail', details: 'output mismatch' }
  assert.equal(qualificationCandidatePassesIsolation(packagedFail, 'packaged'), false)
  // same candidate qualifies in dev where the case does not apply
  const dev = qualifiedCandidate('dev')
  assert.equal(qualificationCandidatePassesIsolation(dev, 'dev'), true)
})

void test('qualification report round-trips through the isolated JOKER home', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-qualification-test-'))
  try {
    const report = makeReport()
    report.level = 'L0'
    writeEvidenceForReport(home, report)
    const path = writeRuntimeQualificationReport(report, home)
    assert.equal(path, getQualificationPath(home))
    assert.deepEqual(readRuntimeQualificationReport(home), { ...report, level: 'L2' })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

void test('readRuntimeQualificationReport repairs a declared level that conflicts with evidence', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-qualification-test-'))
  try {
    const report = makeReport()
    const path = getQualificationPath(home)
    writeEvidenceForReport(home, report)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ ...report, level: 'L0' }), 'utf8')
    assert.equal(readRuntimeQualificationReport(home)?.level, 'L2')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

void test('readRuntimeQualificationReport falls back to a valid backup', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-qualification-test-'))
  try {
    const report = makeReport()
    writeEvidenceForReport(home, report)
    writeRuntimeQualificationReport(report, home)
    writeRuntimeQualificationReport({ ...report, generatedAt: 456 }, home)
    const path = getQualificationPath(home)
    writeFileSync(path, '{broken', 'utf8')
    const recovered = readRuntimeQualificationReport(home)
    assert.equal(recovered?.generatedAt, 123)
    assert.equal(recovered?.level, 'L2')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

void test('readRuntimeQualificationReport fails closed when qualification evidence is missing', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-qualification-test-'))
  try {
    const report = makeReport()
    writeRuntimeQualificationReport(report, home)
    const recovered = readRuntimeQualificationReport(home)
    assert.equal(recovered?.level, 'L0')
    assert.equal(recovered?.candidates.every((candidate) => candidate.passesIsolation === false), true)
    assert.equal(
      recovered?.candidates.flatMap((candidate) => candidate.cases).every((item) => item.status !== 'pass'),
      true
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

void test('readRuntimeQualificationReport rejects mismatched qualification evidence', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-qualification-test-'))
  try {
    const report = makeReport()
    writeEvidenceForReport(home, report)
    const firstEvidence = report.candidates[0].cases[0].evidence
    assert.ok(firstEvidence)
    writeFileSync(join(dirname(getQualificationPath(home)), firstEvidence.path), JSON.stringify({ id: 'different-case' }), 'utf8')
    writeRuntimeQualificationReport(report, home)
    const recovered = readRuntimeQualificationReport(home)
    assert.equal(recovered?.level, 'L0')
    assert.equal(recovered?.candidates[0].cases[0].status, 'inconclusive')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

void test('readRuntimeQualificationReport returns null when missing or schema mismatched', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-qualification-test-'))
  try {
    assert.equal(readRuntimeQualificationReport(home), null)
    const report = makeReport()
    const path = getQualificationPath(home)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ ...report, schemaVersion: 999 }), 'utf-8')
    assert.equal(readRuntimeQualificationReport(home), null)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

void test('qualificationReportFingerprint is stable except for generatedAt and ignores a false declared level', () => {
  const a = makeReport()
  const b = makeReport()
  b.generatedAt = 999
  assert.equal(qualificationReportFingerprint(a), qualificationReportFingerprint(b))
  const c = { ...makeReport(), level: 'L2' as const }
  assert.equal(qualificationReportFingerprint(a), qualificationReportFingerprint(c))
})
