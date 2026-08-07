import { app } from 'electron'
import { mkdirSync, rmSync, cpSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { ForgeJob } from '../../../shared/generated-tools'
import { createForgeJob, hashGeneratedToolSpec, readForgeJob } from '../forge-job-store'
import { ForgeService } from '../forge-service'
import {
  GATE2_QUALIFICATION_TOOL_ID,
  createGate2QualificationMaker,
  gate2QualificationSpec
} from '../gate2-qualification'
import { readEffectiveRuntimeQualificationReport } from '../qualification'
import { readGeneratedToolRegistry } from '../registry'
import { verifyValidationReportBundle } from '../validation-report-store'

export async function runPackagedGate2Qualification(): Promise<boolean> {
  if (process.env['JOKER_PACKAGED_GATE2_QUALIFICATION'] !== '1') return false
  const reportPath = process.env['JOKER_PACKAGED_GATE2_REPORT']
  const jokerHome = process.env['JOKER_HOME']
  if (!reportPath || !jokerHome) throw new Error('Missing packaged Gate 2 qualification paths')
  rmSync(join(jokerHome, '.joker'), { recursive: true, force: true })
  mkdirSync(dirname(reportPath), { recursive: true })
  const qualificationSourceHome = process.env['JOKER_PACKAGED_GATE2_QUALIFICATION_HOME']
  if (!qualificationSourceHome) throw new Error('Missing packaged Gate 2 runtime qualification home')
  const qualification = readEffectiveRuntimeQualificationReport(qualificationSourceHome)
  if (qualification?.level !== 'L2') throw new Error('Packaged Gate 2 qualification requires an existing L2 runtime report')

  const scenarios: Array<{
    scenario: string
    pass: boolean
    status: string | null
    reportStatus: string | null
    candidateId: string | null
    reportId: string | null
    capabilityRevisionBefore: number
    capabilityRevisionAfter: number
    trusted: false
    registered: false
    active: false
    originalTaskComplete: false
  }> = []
  for (const scenario of ['success', 'explicit-failure', 'fake-success', 'overreach'] as const) {
    const scenarioHome = join(jokerHome, scenario)
    cpSync(join(qualificationSourceHome, '.joker', 'qualification'), join(scenarioHome, '.joker', 'qualification'), { recursive: true })
    const spec = gate2QualificationSpec({
      sessionId: `session-${scenario}`,
      runId: `run-${scenario}`,
      userMessageId: `message-${scenario}`
    })
    const id = `forge-packaged-${scenario}`
    const job: ForgeJob = createForgeJob(scenarioHome, {
      id,
      idempotencyKey: `packaged-${scenario}`,
      specHash: hashGeneratedToolSpec(spec),
      toolId: spec.id,
      mode: 'create',
      status: 'queued',
      revision: 0,
      spec,
      attempt: 1,
      maxAttempts: 1,
      createdAt: 1,
      updatedAt: 1,
      artifactPath: `jobs/${id}/workspace`
    })
    const registryBefore = readGeneratedToolRegistry(scenarioHome)
    const service = new ForgeService({ jokerHome: scenarioHome, maker: createGate2QualificationMaker(scenario) })
    service.start()
    await service.waitForIdle()
    const completed = readForgeJob(scenarioHome, job.id)
    const registryAfter = readGeneratedToolRegistry(scenarioHome)
    const report = completed?.validationReportId
      ? verifyValidationReportBundle(scenarioHome, completed.validationReportId)
      : null
    const expectedStatus = scenario === 'success' || scenario === 'explicit-failure' ? 'awaiting-policy' : 'failed'
    const expectedReportStatus = scenario === 'success' || scenario === 'explicit-failure'
      ? 'passed'
      : scenario === 'overreach' ? 'quarantined' : 'failed'
    scenarios.push({
      scenario,
      pass: completed?.status === expectedStatus
        && report?.status === expectedReportStatus
        && registryAfter.revision === registryBefore.revision
        && registryAfter.capabilityRevision.revision === registryBefore.capabilityRevision.revision
        && registryAfter.entries.length === 0,
      status: completed?.status ?? null,
      reportStatus: report?.status ?? null,
      candidateId: completed?.candidateId ?? null,
      reportId: completed?.validationReportId ?? null,
      capabilityRevisionBefore: registryBefore.capabilityRevision.revision,
      capabilityRevisionAfter: registryAfter.capabilityRevision.revision,
      trusted: false,
      registered: false,
      active: false,
      originalTaskComplete: false
    })
  }
  const passed = scenarios.every((item) => item.pass)
  const report = {
    schemaVersion: 1,
    generatedAt: Date.now(),
    qualification: 'toolforge-gate2-packaged',
    environment: 'packaged-windows',
    appVersion: app.getVersion(),
    resourcesPath: process.resourcesPath,
    runNonce: process.env['JOKER_PACKAGED_GATE2_RUN_NONCE'] ?? null,
    toolId: GATE2_QUALIFICATION_TOOL_ID,
    constraints: { provider: 'not-used', externalMcp: 'not-used', publicNetwork: 'not-used', credentials: 'not-used' },
    scenarios,
    passed
  }
  await import('node:fs/promises').then(({ writeFile }) => writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8'))
  app.exit(passed ? 0 : 1)
  return true
}
