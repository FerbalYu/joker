import { app } from 'electron'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { ForgeJob } from '../../../shared/generated-tools'
import { buildToolSet } from '../../tools/registry'
import { buildGeneratedToolDefinitions, listGeneratedToolSnapshotBindings } from '../adapter'
import { sealGeneratedToolCandidate } from '../candidate-store'
import { ContinuationScheduler } from '../continuation-scheduler'
import { setDefaultContinuationScheduler } from '../continuation-scheduler-runtime'
import { GeneratedToolEditService } from '../edit-service'
import { installSummarizeTaskJsonFixture } from '../fixture'
import { readForgeJob } from '../forge-job-store'
import { ForgeService, type ForgeServiceMaker } from '../forge-service'
import { ForgeWorkspaceBroker } from '../forge-workspace'
import { PromotionService } from '../promotion-service'
import { readGeneratedToolRegistry } from '../registry'
import { readGeneratedToolInvocations } from '../invocation-store'
import { getGeneratedToolForManagement } from '../management-read-model'
import { readGeneratedToolVersion } from '../version-store'

const TOOL_ID = 'summarize-task-json'
const PROJECT_ID = 'qualification-p0'
const SUCCESS_SOURCE = `
function summarize(tasks) {
  const counts = {}
  for (const task of tasks) {
    const key = task && task.status ? String(task.status) : 'unknown'
    counts[key] = (counts[key] || 0) + 1
  }
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a] || (a < b ? -1 : a > b ? 1 : 0)).map((key) => key + ': ' + counts[key]).join('\\n')
}
try {
  const rows = JSON.parse(tool.readFile('fixtures/tasks.json'))
  if (!(rows instanceof Array)) tool.fail({ message: 'invalid-task-json' })
  else tool.output(summarize(rows))
} catch (error) {
  if (error && error.message === 'invalid-task-json') throw error
  tool.fail({ message: 'invalid-task-json' })
}
// packaged-gate4-edit-success
`
const FAILURE_SOURCE = "tool.output('packaged-gate4-invalid-edit')\n"

interface PackagedEditScenarioResult {
  scenario: 'success' | 'failure'
  pass: boolean
  jobStatus: ForgeJob['status'] | null
  activeVersionId: string | null
  lastStableVersionId: string | null
  capabilityRevision: number
  versionCount: number
  output: string | null
  invocationOutcome: string | null
  baseFingerprintPreserved: boolean
  promoted?: boolean
  editDiffRecorded?: boolean
  error?: string
}

function makerFor(source: string): ForgeServiceMaker {
  return async (input) => {
    const broker = new ForgeWorkspaceBroker(input.jokerHome, input.job.id)
    broker.writeFile('source/tool.js', source)
    broker.writeFile('dist/tool.js', source)
    if (broker.runCheck().status !== 'passed') throw new Error('Packaged Gate 4 candidate structure check failed')
    const latest = readForgeJob(input.jokerHome, input.job.id)
    if (!latest) throw new Error('Packaged Gate 4 ForgeJob disappeared')
    sealGeneratedToolCandidate({
      jokerHome: input.jokerHome,
      jobId: input.job.id,
      expectedRevision: latest.revision,
      validationSuiteId: input.validationSuiteId,
      validationSuiteHash: input.validationSuiteHash,
      createdAt: Date.now(),
      validationRunId: `packaged-gate4-validation-${input.job.id}-${input.job.attempt}`
    })
    return { output: 'candidate-submitted', usage: undefined, steps: 4 } as never
  }
}

async function invokeActiveTool(jokerHome: string, workspace: string, runId: string): Promise<{ output: string; outcome: string | null }> {
  const bindings = listGeneratedToolSnapshotBindings({ jokerHome, projectId: PROJECT_ID })
  const definitions = buildGeneratedToolDefinitions(workspace, jokerHome, bindings, new Set(), PROJECT_ID)
  const definition = definitions.find((item) => item.name === TOOL_ID)
  if (!definition) throw new Error('Packaged Gate 4 active Generated Tool was not discoverable')
  const toolSet = buildToolSet([definition], {
    workspacePath: workspace,
    sessionId: `packaged-gate4-session-${runId}`,
    runId,
    approvalGate: async () => ({ outcome: 'allow', risk: 'read', reason: 'packaged Gate 4 qualification' })
  })
  const result = await (toolSet[TOOL_ID] as unknown as {
    execute: (input: Record<string, unknown>, options: { toolCallId: string }) => Promise<{ output: string }>
  }).execute({}, { toolCallId: `packaged-gate4-call-${runId}` })
  const invocation = readGeneratedToolInvocations(jokerHome).invocations.find((item) => item.runId === runId)
  return { output: result.output, outcome: invocation?.outcome ?? null }
}

async function runScenario(
  rootHome: string,
  workspace: string,
  fixtureRoot: string,
  qualificationSourceHome: string,
  scenario: 'success' | 'failure'
): Promise<PackagedEditScenarioResult> {
  const jokerHome = join(rootHome, scenario)
  rmSync(jokerHome, { recursive: true, force: true })
  cpSync(join(qualificationSourceHome, '.joker', 'qualification'), join(jokerHome, '.joker', 'qualification'), { recursive: true })
  const base = installSummarizeTaskJsonFixture(jokerHome, Date.now(), { fixtureRoot })
  const edit = new GeneratedToolEditService({ jokerHome, createId: () => `packaged-gate4-${scenario}`, now: Date.now })
  const started = edit.start({
    toolId: TOOL_ID,
    baseVersionId: base.id,
    baseFingerprint: base.fingerprint,
    instruction: scenario === 'success' ? 'Preserve behavior and improve the implementation.' : 'Manufacture an invalid edit for failure retention qualification.',
    requestedFrom: 'settings'
  }, `packaged-gate4-${scenario}-session`, `packaged-gate4-${scenario}-source-run`)
  if (!started.success) throw new Error(started.error.message)

  const forge = new ForgeService({ jokerHome, maker: makerFor(scenario === 'success' ? SUCCESS_SOURCE : FAILURE_SOURCE) })
  forge.start()
  await forge.waitForIdle()
  let job = readForgeJob(jokerHome, started.data.jobId)
  if (!job) throw new Error('Packaged Gate 4 edit job is missing')

  let promoted = false
  if (scenario === 'success') {
    if (job.status !== 'awaiting-policy' || !job.candidateFingerprint) throw new Error(`Successful packaged edit stopped at ${job.status}`)
    const scheduler = new ContinuationScheduler({ jokerHome })
    setDefaultContinuationScheduler(scheduler)
    try {
      const result = await new PromotionService({ jokerHome }).promote({
        jobId: job.id,
        expectedJobRevision: job.revision,
        registryRevision: readGeneratedToolRegistry(jokerHome).revision,
        expectedCandidateFingerprint: job.candidateFingerprint
      })
      promoted = result.action === 'promoted'
      const promotedJob = readForgeJob(jokerHome, job.id)
      if (!promotedJob) throw new Error('Packaged Gate 4 promoted job disappeared')
      job = promotedJob
    } finally {
      setDefaultContinuationScheduler(null)
    }
  }

  const registry = readGeneratedToolRegistry(jokerHome)
  const pointer = registry.activePointers.find((item) => item.toolId === TOOL_ID)
  const activeVersionId = pointer?.activeVersionId ?? null
  const invocation = await invokeActiveTool(jokerHome, workspace, `${scenario}-run`)
  const baseAfter = readGeneratedToolVersion(jokerHome, TOOL_ID, base.id)
  const detail = getGeneratedToolForManagement(TOOL_ID, jokerHome)
  const activeVersion = detail.success && activeVersionId
    ? detail.data.versions.find((version) => version.id === activeVersionId)
    : undefined
  const entry = registry.entries.find((item) => item.toolId === TOOL_ID)
  const baseFingerprintPreserved = baseAfter.fingerprint === base.fingerprint
  const common = invocation.output === 'open: 4\ndone: 3\nin_progress: 2'
    && invocation.outcome === 'succeeded'
    && baseFingerprintPreserved

  if (scenario === 'success') {
    const editDiffRecorded = activeVersion?.editDiff?.baseVersionId === base.id
      && activeVersion.editDiff.baseFingerprint === base.fingerprint
      && activeVersion.editDiff.sourceChanged
      && activeVersion.editDiff.permissions.expanded === false
    return {
      scenario,
      pass: common && promoted && job?.status === 'completed' && activeVersionId !== base.id
        && pointer?.lastStableVersionId === activeVersionId && registry.capabilityRevision.revision === 2
        && entry?.versionIds.length === 2 && editDiffRecorded,
      jobStatus: job?.status ?? null,
      activeVersionId,
      lastStableVersionId: pointer?.lastStableVersionId ?? null,
      capabilityRevision: registry.capabilityRevision.revision,
      versionCount: entry?.versionIds.length ?? 0,
      output: invocation.output,
      invocationOutcome: invocation.outcome,
      baseFingerprintPreserved,
      promoted,
      editDiffRecorded
    }
  }

  return {
    scenario,
    pass: common && job.status === 'failed' && activeVersionId === base.id
      && pointer?.lastStableVersionId === base.id && registry.capabilityRevision.revision === 1
      && entry?.versionIds.length === 1,
    jobStatus: job.status,
    activeVersionId,
    lastStableVersionId: pointer?.lastStableVersionId ?? null,
    capabilityRevision: registry.capabilityRevision.revision,
    versionCount: entry?.versionIds.length ?? 0,
    output: invocation.output,
    invocationOutcome: invocation.outcome,
    baseFingerprintPreserved,
    error: job.error
  }
}

export async function runPackagedGate4EditQualification(): Promise<boolean> {
  if (process.env['JOKER_PACKAGED_GATE4_EDIT_QUALIFICATION'] !== '1') return false
  const reportPath = process.env['JOKER_PACKAGED_GATE4_EDIT_REPORT']?.trim()
  const jokerHome = process.env['JOKER_HOME']?.trim()
  const workspace = process.env['JOKER_PACKAGED_GATE4_EDIT_WORKSPACE']?.trim()
  const fixtureRoot = process.env['JOKER_PACKAGED_GATE4_EDIT_FIXTURE_ROOT']?.trim()
  const qualificationSourceHome = process.env['JOKER_PACKAGED_GATE4_QUALIFICATION_HOME']?.trim()
  if (!reportPath || !jokerHome || !workspace || !fixtureRoot || !qualificationSourceHome) {
    throw new Error('Packaged Gate 4 edit qualification environment is incomplete')
  }

  mkdirSync(dirname(reportPath), { recursive: true })
  const scenarios: PackagedEditScenarioResult[] = []
  try {
    scenarios.push(await runScenario(jokerHome, workspace, fixtureRoot, qualificationSourceHome, 'success'))
    scenarios.push(await runScenario(jokerHome, workspace, fixtureRoot, qualificationSourceHome, 'failure'))
  } catch (error) {
    scenarios.push({
      scenario: scenarios.length === 0 ? 'success' : 'failure',
      pass: false,
      jobStatus: null,
      activeVersionId: null,
      lastStableVersionId: null,
      capabilityRevision: 0,
      versionCount: 0,
      output: null,
      invocationOutcome: null,
      baseFingerprintPreserved: false,
      error: error instanceof Error ? error.message : String(error)
    })
  }
  const passed = scenarios.length === 2 && scenarios.every((item) => item.pass)
  const report = {
    schemaVersion: 1,
    qualification: 'toolforge-gate4-edit-packaged',
    environment: 'packaged-windows',
    generatedAt: Date.now(),
    appVersion: app.getVersion(),
    resourcesPath: process.resourcesPath,
    runNonce: process.env['JOKER_PACKAGED_GATE4_EDIT_RUN_NONCE'] ?? null,
    constraints: { provider: 'not-used', externalMcp: 'not-used', publicNetwork: 'not-used', credentials: 'not-used' },
    scenarios,
    passed
  }
  await import('node:fs/promises').then(({ writeFile }) => writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8'))
  app.exit(passed ? 0 : 1)
  return true
}
