import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildToolForgeMetaTools } from '../src/main/tools/tool-forge.ts'
import { readForgeJob } from '../src/main/generated-tools/forge-job-store.ts'
import { ForgeService } from '../src/main/generated-tools/forge-service.ts'
import { PromotionService } from '../src/main/generated-tools/promotion-service.ts'
import { ContinuationScheduler } from '../src/main/generated-tools/continuation-scheduler.ts'
import { setDefaultContinuationScheduler } from '../src/main/generated-tools/continuation-scheduler-runtime.ts'
import { installRuntimeQualificationFixture } from '../src/main/generated-tools/test-fixtures.ts'
import { sealGeneratedToolCandidate } from '../src/main/generated-tools/candidate-store.ts'
import { readGeneratedToolCandidate } from '../src/main/generated-tools/candidate-store.ts'
import { verifyValidationReportBundle } from '../src/main/generated-tools/validation-report-store.ts'
import { readPromotionJournals } from '../src/main/generated-tools/promotion-journal-store.ts'
import { readGeneratedToolRegistry } from '../src/main/generated-tools/registry.ts'
import { readContinuationV2State } from '../src/main/generated-tools/continuation-v2.ts'
import { readGeneratedToolInvocations } from '../src/main/generated-tools/invocation-store.ts'
import { listGeneratedToolSnapshotBindings, buildGeneratedToolDefinitions } from '../src/main/generated-tools/adapter.ts'
import { executeToolDefinition } from '../src/main/tools/registry.ts'
import { registerGeneratedToolValidationSuite, fingerprintGeneratedToolValidationSuite } from '../src/main/generated-tools/validation-suite.ts'
import { hashGeneratedToolSpec } from '../src/main/generated-tools/forge-job-store.ts'

const TOOL_ID = 'vertical-slice-task-summary'
const PROJECT_ID = 'vertical-slice-project'
const SESSION_ID = 'vertical-slice-session'
const SOURCE_RUN_ID = 'vertical-slice-source-run'
const SOURCE_MESSAGE_ID = 'vertical-slice-user-message'
const FIXED_TIME = 1_700_000_000_000

const permissions = {
  filesystem: { read: ['fixtures/tasks.json'], write: [] },
  network: { hosts: [], methods: [] },
  process: { commands: [] },
  environment: { keys: [] },
  secrets: { handles: [] }
}

const manifest = {
  schemaVersion: 1,
  toolId: TOOL_ID,
  displayName: 'VerticalSliceTaskSummary',
  description: 'Reads project task JSON and returns deterministic status counts.',
  sdkVersion: '1.0.0',
  runtime: { id: 'quickjs-wasm', version: '0.32.0' },
  entrypoint: 'source/tool.js',
  inputSchema: { type: 'object', additionalProperties: false },
  outputSchema: { type: 'string' },
  errorContract: {
    type: 'object',
    properties: { message: { type: 'string' } },
    required: ['message'],
    additionalProperties: false
  },
  permissions,
  dependencies: [],
  limits: { timeoutMs: 1_000, maxInputBytes: 4_096, maxOutputBytes: 16_384, maxMemoryBytes: 32_000_000 }
}

  const source = `
function summarize(tasks) {
  const counts = {}
  for (const task of tasks) {
    const key = task && task.status ? String(task.status) : 'unknown'
    counts[key] = (counts[key] || 0) + 1
  }
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a] || (a < b ? -1 : a > b ? 1 : 0)).map((key) => key + ': ' + counts[key]).join('\\n')
}
try {
  const raw = tool.readFile('fixtures/tasks.json')
  const rows = JSON.parse(raw)
  if (!(rows instanceof Array)) {
    tool.fail({ message: 'invalid-task-json' })
  } else {
    tool.output(summarize(rows))
  }
} catch (error) {
  if (error && error.message === 'invalid-task-json') throw error
  tool.fail({ message: 'invalid-task-json' })
}
`

const suite = {
  id: 'vertical-slice-task-summary-v1',
  toolId: TOOL_ID,
  cases: [
    {
      id: 'success',
      input: {},
      workspaceFiles: {
        'fixtures/tasks.json': JSON.stringify([{ status: 'open' }, { status: 'open' }, { status: 'done' }])
      },
      expected: { outcome: 'succeeded', output: 'open: 2\ndone: 1' }
    },
    {
      id: 'invalid-json',
      input: {},
      workspaceFiles: { 'fixtures/tasks.json': '{invalid json' },
      expected: { outcome: 'tool-failed', error: { message: 'invalid-task-json' } }
    }
  ]
}

registerGeneratedToolValidationSuite(suite)

function json(value) {
  return JSON.parse(value.output)
}

function check(name, value, details = undefined) {
  const item = { name, pass: Boolean(value), ...(details === undefined ? {} : { details }) }
  checks.push(item)
  if (!item.pass) throw new Error(`${name}: ${JSON.stringify(details ?? value)}`)
}

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const retainDirArg = process.argv.find((argument) => argument.startsWith('--retain-dir='))
const retainDir = retainDirArg ? resolve(root, retainDirArg.slice('--retain-dir='.length)) : null
const checks = []
const runDir = mkdtempSync(join(tmpdir(), 'joker-toolforge-vertical-slice-'))
const home = join(runDir, 'home')
const workspace = join(runDir, 'project')
const reportPath = join(runDir, 'vertical-slice-report.json')
mkdirSync(workspace, { recursive: true })
mkdirSync(join(workspace, 'fixtures'), { recursive: true })
writeFileSync(join(workspace, 'fixtures', 'tasks.json'), JSON.stringify([{ status: 'open' }, { status: 'open' }, { status: 'done' }]))

let forgeService
let scheduler
let failure
let activationOutput
let invocationOutput

try {
  installRuntimeQualificationFixture(home, 'L2')
  const sourceSpec = {
    id: TOOL_ID,
    displayName: manifest.displayName,
    goal: 'Read fixtures/tasks.json and return status counts.',
    reason: 'The current task needs deterministic project task summarization.',
    requestedBy: { sessionId: SESSION_ID, runId: SOURCE_RUN_ID, userMessageId: SOURCE_MESSAGE_ID },
    scope: 'project',
    projectId: PROJECT_ID,
    inputContract: manifest.inputSchema,
    outputContract: manifest.outputSchema,
    permissions,
    acceptance: ['Valid task JSON returns sorted status counts.', 'Invalid task JSON returns explicit invalid-task-json failure.'],
    examples: [{ input: {}, expected: 'open: 2\ndone: 1' }]
  }

  const maker = async (input) => {
    const { ForgeWorkspaceBroker } = await import('../src/main/generated-tools/forge-workspace.ts')
    const broker = new ForgeWorkspaceBroker(input.jokerHome, input.job.id)
    check(
      'isolated-job-environment binds manufacturing to the exact ForgeJob workspace',
      broker.job.id === input.job.id &&
        broker.root === resolve(input.jokerHome, '.joker', 'generated-tools', input.job.artifactPath) &&
        input.job.artifactPath === `jobs/${input.job.id}/workspace`,
      { jobId: broker.job.id, artifactPath: input.job.artifactPath }
    )
    broker.writeFile('manifest.json', `${JSON.stringify(manifest, null, 2)}
`)
    const attemptSource = input.job.attempt > 1
      ? `${source}\n// repair attempt ${input.job.attempt}`
      : source
    broker.writeFile('source/tool.js', attemptSource)
    broker.writeFile('dist/tool.js', attemptSource)
    const forgeCheck = broker.runCheck()
    check('ForgeAgent host check passes', forgeCheck.status === 'passed', forgeCheck)
    const latest = readForgeJob(input.jokerHome, input.job.id)
    if (!latest) throw new Error('ForgeJob disappeared before candidate sealing')
    sealGeneratedToolCandidate({
      jokerHome: input.jokerHome,
      jobId: latest.id,
      expectedRevision: latest.revision,
      validationSuiteId: input.validationSuiteId,
      validationSuiteHash: input.validationSuiteHash,
      createdAt: FIXED_TIME + 1,
      validationRunId: `validation-${latest.id}`
    })
    return { output: 'candidate submitted', usage: undefined, steps: 4 }
  }

  const promotionService = new PromotionService({ jokerHome: home, now: () => FIXED_TIME + 4 })
  scheduler = new ContinuationScheduler({ jokerHome: home, now: () => FIXED_TIME + 3, createId: () => 'vertical-dispatch' })
  setDefaultContinuationScheduler(scheduler)
  forgeService = new ForgeService({
    jokerHome: home,
    maker,
    now: () => FIXED_TIME + 2,
    activationDriver: async (jobId) => {
      activationOutput = await promotionService.advance(jobId)
      return activationOutput
    }
  })
  forgeService.start()

  const metaTools = buildToolForgeMetaTools({
    jokerHome: home,
    builtinTools: [],
    now: () => FIXED_TIME,
    createId: () => 'vertical-job',
    controller: forgeService
  })
  const context = {
    workspacePath: workspace,
    sessionId: SESSION_ID,
    runId: SOURCE_RUN_ID,
    approvalGate: async () => ({ outcome: 'allow', risk: 'read', reason: 'vertical-slice host harness' })
  }
  const toolSearch = metaTools.find((tool) => tool.name === 'ToolSearch')
  const toolForgeStart = metaTools.find((tool) => tool.name === 'ToolForgeStart')
  check('ToolSearch is available', Boolean(toolSearch))
  check('ToolForgeStart is available', Boolean(toolForgeStart))
  check('Model-facing ToolForge surface is ToolSearch → ToolForgeStart only', metaTools.map((tool) => tool.name).join(',') === 'ToolSearch,ToolForgeStart', metaTools.map((tool) => tool.name))

  const searchResult = json(await toolSearch.execute({ query: TOOL_ID }, context))
  check('ToolSearch reports the missing capability before manufacturing', searchResult.match === 'missing' && searchResult.results.length === 0, searchResult)

  const started = json(await toolForgeStart.execute({ idempotencyKey: 'vertical-slice-start-1', mode: 'create', maxAttempts: 3, spec: sourceSpec }, context))
  check('ToolForge invocation executes ToolForgeStart and returns the durable ForgeJob identity', started.status === 'queued' && typeof started.jobId === 'string' && started.jobId.length > 0, started)
  check('ToolForgeStart creates a durable incomplete ForgeJob', started.status === 'queued' && started.originalTaskComplete === false)
  const jobId = started.jobId
  const registryBeforeActivation = readGeneratedToolRegistry(home)
  check('Old stable pointer was absent before host activation', registryBeforeActivation.activePointers.every((pointer) => pointer.toolId !== TOOL_ID), registryBeforeActivation)

  const callOrder = []
  scheduler.attach(1, {
    isSessionRunning: () => false,
    dispatch: async (continuation) => {
      const current = scheduler.read(continuation.id)
      if (!current || current.status !== 'dispatched' || current.continuationRunId !== continuation.continuationRunId) throw new Error('Continuation claim lost')
      const running = scheduler.markRunning(current.id, current.revision)
      const binding = listGeneratedToolSnapshotBindings({ jokerHome: home, projectId: PROJECT_ID }).find((item) => item.toolId === continuation.toolId && item.versionId === continuation.versionId && item.fingerprint === continuation.fingerprint && item.validationReportId === continuation.validationReportId && item.capabilityRevision === continuation.toCapabilityRevision)
      check('Continuation rebuilds ToolSet from the exact enabled snapshot', Boolean(binding), { continuation, binding })
      const definition = buildGeneratedToolDefinitions(workspace, home, [binding], new Set(), PROJECT_ID)[0]
      check('Continuation first tool is the exact enabled Generated Tool', definition?.source?.type === 'generated' && definition.source.toolId === continuation.toolId && definition.source.versionId === continuation.versionId && definition.source.fingerprint === continuation.fingerprint && definition.source.validationReportId === continuation.validationReportId && definition.source.capabilityRevision === continuation.toCapabilityRevision, definition?.source)
      callOrder.push(definition.name)
      invocationOutput = await executeToolDefinition(definition, {}, {
        workspacePath: workspace,
        sessionId: continuation.sessionId,
        runId: continuation.continuationRunId,
        approvalGate: async () => ({ outcome: 'allow', risk: 'read', reason: 'vertical-slice generated tool' })
      }, undefined, 'vertical-first-tool-call')
      scheduler.complete(running.id, scheduler.read(running.id).revision)
    }
  })

  await forgeService.waitForIdle()
  const completed = readForgeJob(home, jobId)
  const candidate = completed?.candidateId ? readGeneratedToolCandidate(home, jobId, completed.candidateId) : undefined
  const report = completed?.validationReportId ? verifyValidationReportBundle(home, completed.validationReportId) : undefined
  check('ForgeService independently validates and host-enables the Generated Tool', completed?.status === 'completed' && activationOutput?.action === 'promoted' && Boolean(candidate) && Boolean(report), { job: completed, activation: activationOutput })
  check('Candidate is immutable and fingerprint-bound', Boolean(candidate?.artifactFingerprint) && candidate?.trusted !== true, candidate)
  check('independent-validator binds the host validation report to the sealed candidate fingerprint', report?.status === 'passed' && report.artifactFingerprint === candidate?.artifactFingerprint, report)

  const registryAfterActivation = readGeneratedToolRegistry(home)
  check('Policy → host enable completes with a trusted immutable version', activationOutput?.action === 'promoted' && activationOutput.job.status === 'completed' && activationOutput.versionId !== undefined, activationOutput)
  check('Capability revision increments exactly once', activationOutput?.capabilityRevision === 1 && registryAfterActivation.capabilityRevision.revision === 1)
  check('Enabled pointer targets the trusted version', registryAfterActivation.activePointers.some((pointer) => pointer.toolId === TOOL_ID && pointer.activeVersionId === activationOutput?.versionId && pointer.lastStableVersionId === activationOutput?.versionId), registryAfterActivation)
  check('Promotion journal is durably completed', readPromotionJournals(home).journals.some((journal) => journal.jobId === jobId && journal.versionId === activationOutput?.versionId && journal.phase === 'completed'))
  check('Continuation is durably completed', readContinuationV2State(home).continuations.some((item) => item.jobId === jobId && item.status === 'completed'))
  check('Exactly one exact Generated Tool first call occurred', callOrder.length === 1 && callOrder[0] === TOOL_ID, callOrder)
  check('Generated Tool returned the task summary', invocationOutput?.output === 'open: 2\ndone: 1', invocationOutput)

  const invocations = readGeneratedToolInvocations(home).invocations
  check('Invocation lifecycle has proposed, policy, started, and finished evidence', invocations.length === 1 && invocations[0].status === 'finished' && invocations[0].outcome === 'succeeded', invocations)
  check('Only one user message was needed for the original task', SOURCE_MESSAGE_ID === 'vertical-slice-user-message')

  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    qualification: 'toolforge-vertical-slice-node',
    runDir,
    isolatedHome: home,
    projectWorkspace: workspace,
    constraints: { provider: 'not-used', externalMcp: 'not-used', publicNetwork: 'not-used', credentials: 'not-used' },
    suiteId: suite.id,
    suiteHash: fingerprintGeneratedToolValidationSuite(suite),
    toolId: TOOL_ID,
    checks,
    evidence: {
      forgeJob: completed,
      candidate,
      validationReport: report,
      promotionJournals: readPromotionJournals(home).journals,
      registry: readGeneratedToolRegistry(home),
      continuations: readContinuationV2State(home).continuations,
      invocations
    },
    passed: checks.every((item) => item.pass)
  }
  writeFileSync(reportPath, `${JSON.stringify(output, null, 2)}\n`)
  console.log(JSON.stringify({ reportPath, passed: output.passed, checks }, null, 2))
  if (!output.passed) process.exitCode = 1
} catch (error) {
  failure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) }
  const output = { schemaVersion: 1, generatedAt: new Date().toISOString(), qualification: 'toolforge-vertical-slice-node', runDir, isolatedHome: home, checks, failure, passed: false }
  writeFileSync(reportPath, `${JSON.stringify(output, null, 2)}\n`)
  console.error(JSON.stringify({ reportPath, passed: false, failure }, null, 2))
  process.exitCode = 1
} finally {
  setDefaultContinuationScheduler(null)
  if (retainDir) {
    rmSync(retainDir, { recursive: true, force: true })
    mkdirSync(retainDir, { recursive: true })
    cpSync(runDir, retainDir, { recursive: true })
  }
  if (process.argv.includes('--clean')) rmSync(runDir, { recursive: true, force: true })
}
