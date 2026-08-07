import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createForgeJob, hashGeneratedToolSpec, readForgeJob } from '../src/main/generated-tools/forge-job-store.ts'
import { ForgeService } from '../src/main/generated-tools/forge-service.ts'
import {
  GATE2_QUALIFICATION_TOOL_ID,
  createGate2QualificationMaker,
  gate2QualificationSpec
} from '../src/main/generated-tools/gate2-qualification.ts'
import { installRuntimeQualificationFixture } from '../src/main/generated-tools/test-fixtures.ts'
import { readGeneratedToolRegistry } from '../src/main/generated-tools/registry.ts'
import { verifyValidationReportBundle } from '../src/main/generated-tools/validation-report-store.ts'
import { runGeneratedTool } from '../src/main/generated-tools/runtime/runner.ts'
import { readGeneratedToolCandidate } from '../src/main/generated-tools/candidate-store.ts'

const root = mkdtempSync(join(tmpdir(), 'joker-toolforge-gate2-'))
const reportPath = join(root, 'toolforge-gate2-report.json')

function writeReport(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function createJob(home, scenario) {
  const spec = gate2QualificationSpec({
    sessionId: `session-${scenario}`,
    runId: `run-${scenario}`,
    userMessageId: `message-${scenario}`
  })
  return createForgeJob(home, {
    id: `forge-${scenario}-${randomUUID()}`.slice(0, 128),
    idempotencyKey: `gate2-${scenario}-${randomUUID()}`,
    specHash: hashGeneratedToolSpec(spec),
    toolId: spec.id,
    mode: 'create',
    status: 'queued',
    revision: 0,
    spec,
    attempt: 1,
    maxAttempts: scenario === 'fake-success' ? 1 : 3,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    artifactPath: `jobs/forge-${scenario}-${randomUUID()}/workspace`
  })
}

async function runScenario(scenario) {
  const home = join(root, scenario)
  mkdirSync(home, { recursive: true })
  installRuntimeQualificationFixture(home)
  const registryBefore = readGeneratedToolRegistry(home)
  const job = createJob(home, scenario)
  const service = new ForgeService({ jokerHome: home, maker: createGate2QualificationMaker(scenario) })
  service.start()
  await service.waitForIdle()
  const completed = readForgeJob(home, job.id)
  if (!completed) throw new Error(`missing ${scenario} job`)
  const registryAfter = readGeneratedToolRegistry(home)
  const report = completed.validationReportId
    ? verifyValidationReportBundle(home, completed.validationReportId)
    : null
  const candidate = completed.candidateId
    ? readGeneratedToolCandidate(home, completed.id, completed.candidateId)
    : null
  let explicitFailureOutcome = null
  if (scenario === 'explicit-failure' && candidate) {
    const source = readFileSync(join(home, '.joker', 'generated-tools', ...candidate.artifactPath.split('/'), candidate.manifest.entrypoint), 'utf8')
    const result = await runGeneratedTool({
      manifest: candidate.manifest,
      source,
      workspacePath: join(home, 'explicit-failure-workspace'),
      input: { fail: true }
    })
    explicitFailureOutcome = result.outcome
  }
  const expectedStatus = scenario === 'success' || scenario === 'explicit-failure' ? 'awaiting-policy' : 'failed'
  const expectedReportStatus = scenario === 'success' || scenario === 'explicit-failure'
    ? 'passed'
    : scenario === 'overreach' ? 'quarantined' : 'failed'
  const pass = completed.status === expectedStatus
    && report?.status === expectedReportStatus
    && registryAfter.revision === registryBefore.revision
    && registryAfter.capabilityRevision.revision === registryBefore.capabilityRevision.revision
    && registryAfter.entries.length === 0
    && (scenario !== 'explicit-failure' || explicitFailureOutcome === 'tool-failed')
  return {
    scenario,
    pass,
    home,
    jobId: completed.id,
    status: completed.status,
    attempt: completed.attempt,
    candidateId: completed.candidateId ?? null,
    reportId: completed.validationReportId ?? null,
    reportStatus: report?.status ?? null,
    explicitFailureOutcome,
    trusted: false,
    registered: false,
    active: false,
    capabilityRevisionBefore: registryBefore.capabilityRevision.revision,
    capabilityRevisionAfter: registryAfter.capabilityRevision.revision,
    originalTaskComplete: false
  }
}

async function runInterruption() {
  const scenario = 'interruption'
  const home = join(root, scenario)
  mkdirSync(home, { recursive: true })
  installRuntimeQualificationFixture(home)
  const registryBefore = readGeneratedToolRegistry(home)
  const job = createJob(home, scenario)
  let release
  const barrier = new Promise((resolve) => { release = resolve })
  const baseMaker = createGate2QualificationMaker('success')
  const first = new ForgeService({
    jokerHome: home,
    maker: async (input) => {
      await barrier
      return baseMaker(input)
    }
  })
  first.start()
  while (readForgeJob(home, job.id)?.status !== 'building') await new Promise((resolve) => setTimeout(resolve, 0))
  const stopping = first.stop()
  release()
  await stopping
  const interrupted = readForgeJob(home, job.id)
  const second = new ForgeService({ jokerHome: home, maker: baseMaker })
  second.start()
  await second.waitForIdle()
  const resumed = readForgeJob(home, job.id)
  const registryAfter = readGeneratedToolRegistry(home)
  const report = resumed?.validationReportId ? verifyValidationReportBundle(home, resumed.validationReportId) : null
  const pass = interrupted?.status === 'interrupted'
    && resumed?.status === 'awaiting-policy'
    && report?.status === 'passed'
    && registryAfter.revision === registryBefore.revision
    && registryAfter.capabilityRevision.revision === registryBefore.capabilityRevision.revision
    && registryAfter.entries.length === 0
  return {
    scenario,
    pass,
    home,
    jobId: job.id,
    interruptedStatus: interrupted?.status ?? null,
    resumeHint: interrupted?.resumeHint ?? null,
    resumedStatus: resumed?.status ?? null,
    reportStatus: report?.status ?? null,
    trusted: false,
    registered: false,
    active: false,
    capabilityRevisionBefore: registryBefore.capabilityRevision.revision,
    capabilityRevisionAfter: registryAfter.capabilityRevision.revision,
    originalTaskComplete: false
  }
}

try {
  const scenarios = []
  for (const scenario of ['success', 'explicit-failure', 'fake-success', 'overreach']) {
    scenarios.push(await runScenario(scenario))
  }
  scenarios.push(await runInterruption())
  const passed = scenarios.every((item) => item.pass)
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    qualification: 'toolforge-gate2',
    toolId: GATE2_QUALIFICATION_TOOL_ID,
    isolatedRoot: root,
    constraints: {
      provider: 'not-used',
      externalMcp: 'not-used',
      publicNetwork: 'not-used',
      credentials: 'not-used'
    },
    scenarios,
    passed
  }
  writeReport(reportPath, report)
  console.log(JSON.stringify({ reportPath, passed, runDir: root }))
  if (!passed) process.exitCode = 1
} catch (error) {
  writeReport(reportPath, {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    qualification: 'toolforge-gate2',
    passed: false,
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error)
  })
  console.error(JSON.stringify({ reportPath, passed: false, runDir: root }))
  process.exitCode = 1
}

if (process.argv.includes('--clean')) rmSync(root, { recursive: true, force: true })
