import { readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type {
  ForgeJob,
  GeneratedToolCandidate,
  GeneratedToolValidationCheck,
  GeneratedToolValidationReport
} from '../../shared/generated-tools'
import { canonicalGeneratedToolJson } from '../../shared/generated-tools-schema'
import { readGeneratedToolCandidate, verifyGeneratedToolCandidate } from './candidate-store'
import { readForgeJob, updateForgeJob } from './forge-job-store'
import { compileGeneratedToolContractSchema, compileGeneratedToolInputSchema } from './json-schema'
import { readEffectiveRuntimeQualificationReport } from './qualification'
import { runGeneratedTool, type GeneratedToolRunResult } from './runtime/runner'
import { generatedToolsRoot } from './store'
import { commitValidationReportBundle, type ValidationReportArtifact } from './validation-report-store'
import { getGeneratedToolValidationSuite, type GeneratedToolValidationSuite } from './validation-suite'

export const MANDATORY_GATE2_CHECKS = [
  ['runtime-qualified', 'audit'],
  ['candidate-integrity-preflight', 'audit'],
  ['manifest-schema', 'schema'],
  ['spec-manifest-contract', 'contract'],
  ['project-read-profile', 'permission'],
  ['entrypoint-load', 'build'],
  ['acceptance-success', 'unit'],
  ['acceptance-explicit-failure', 'contract'],
  ['capability-conformance', 'permission'],
  ['execution-budgets', 'timeout'],
  ['candidate-integrity-postflight', 'audit']
] as const

interface CheckFact {
  status: GeneratedToolValidationCheck['status']
  message: string
  quarantine?: boolean
  details?: unknown
}

interface ValidationFacts {
  checks: Map<string, CheckFact>
  results: Array<{ caseId: string; expected: unknown; result: GeneratedToolRunResult }>
}

function check(_id: string, status: CheckFact['status'], message: string, details?: unknown, quarantine = false): CheckFact {
  return { status, message, details, quarantine }
}

function exactJson(left: unknown, right: unknown): boolean {
  return canonicalGeneratedToolJson(left) === canonicalGeneratedToolJson(right)
}

function projectReadProfile(candidate: GeneratedToolCandidate): void {
  const manifest = candidate.manifest
  if (manifest.runtime.id !== 'quickjs-wasm' || manifest.dependencies.length > 0 ||
    manifest.permissions.filesystem.write.length > 0 || manifest.permissions.network.hosts.length > 0 ||
    manifest.permissions.process.commands.length > 0 || manifest.permissions.environment.keys.length > 0 ||
    manifest.permissions.secrets.handles.length > 0) {
    throw new Error('Candidate declares capabilities outside gate2-project-read-v1')
  }
}

function readCandidateSource(jokerHome: string, candidate: GeneratedToolCandidate): string {
  return readFileSync(join(generatedToolsRoot(jokerHome), ...candidate.artifactPath.split('/'), ...candidate.manifest.entrypoint.split('/')), 'utf8')
}

function workspaceForCase(jokerHome: string, jobId: string, validationRunId: string, caseId: string, files: Record<string, string>): string {
  const root = join(generatedToolsRoot(jokerHome), 'jobs', jobId, 'validation-runs', validationRunId, 'cases', caseId)
  rmSync(root, { recursive: true, force: true })
  for (const [path, bytes] of Object.entries(files)) {
    const target = join(root, ...path.split('/'))
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, bytes, 'utf8')
  }
  return root
}

function deriveStatus(facts: ValidationFacts): GeneratedToolValidationReport['status'] {
  if ([...facts.checks.values()].some((item) => item.quarantine)) return 'quarantined'
  return [...facts.checks.values()].some((item) => item.status !== 'passed') ? 'failed' : 'passed'
}

function evidenceFor(id: string, fact: CheckFact): ValidationReportArtifact {
  return {
    path: `evidence/${id}.json`,
    bytes: `${JSON.stringify({ id, status: fact.status, message: fact.message, details: fact.details ?? null }, null, 2)}\n`
  }
}

function reportChecks(facts: ValidationFacts): GeneratedToolValidationCheck[] {
  return MANDATORY_GATE2_CHECKS.map(([id, category]) => {
    const fact = facts.checks.get(id) ?? check(id, 'skipped', 'Check was not safely executable')
    return { id, category, status: fact.status, evidencePath: `evidence/${id}.json`, message: fact.message }
  })
}

function attachTerminalReport(jokerHome: string, job: ForgeJob, report: GeneratedToolValidationReport): ForgeJob {
  const status = report.status === 'passed' ? 'awaiting-policy' : 'failed'
  return updateForgeJob(jokerHome, job.id, job.revision, (current) => ({
    ...current,
    revision: current.revision + 1,
    status,
    updatedAt: Math.max(current.updatedAt, report.finishedAt),
    ...(status === 'failed' ? { finishedAt: report.finishedAt, error: `validation-${report.status}` } : {}),
    validationReportId: report.id,
    currentPhase: status === 'awaiting-policy' ? 'awaiting-policy' : 'validation-failed'
  }))
}

export async function validateGeneratedToolCandidate(
  jokerHome: string,
  jobId: string,
  expectedRevision: number,
  signal?: AbortSignal
): Promise<{ report?: GeneratedToolValidationReport; job: ForgeJob; outcome: 'completed' | 'cancelled' }> {
  const job = readForgeJob(jokerHome, jobId)
  if (!job) throw new Error(`ForgeJob not found: ${jobId}`)
  if (job.revision !== expectedRevision) throw new Error('ForgeJob revision is stale')
  if (job.status !== 'validating' || !job.candidateId || !job.validationRunId) throw new Error('ForgeJob is not ready for validation')
  const candidate = readGeneratedToolCandidate(jokerHome, job.id, job.candidateId)
  if (!candidate) throw new Error('ForgeJob candidate is missing')
  const startedAt = Date.now()
  const facts: ValidationFacts = { checks: new Map(), results: [] }
  let suite: GeneratedToolValidationSuite | undefined
  let source = ''

  const qualification = readEffectiveRuntimeQualificationReport(jokerHome)
  const runtimeQualified = qualification?.level === 'L1' || qualification?.level === 'L2'
  facts.checks.set('runtime-qualified', runtimeQualified
    ? check('runtime-qualified', 'passed', `QuickJS runtime is qualified at ${qualification?.level}`)
    : check('runtime-qualified', 'failed', 'Generated Tool validation requires at least L1 QuickJS runtime'))

  try {
    verifyGeneratedToolCandidate(jokerHome, candidate)
    facts.checks.set('candidate-integrity-preflight', check('candidate-integrity-preflight', 'passed', 'Candidate fingerprint matches sealed metadata'))
    compileGeneratedToolInputSchema(candidate.manifest.inputSchema)
    compileGeneratedToolContractSchema(candidate.manifest.outputSchema)
    compileGeneratedToolContractSchema(candidate.manifest.errorContract)
    facts.checks.set('manifest-schema', check('manifest-schema', 'passed', 'Manifest contracts compile under the supported JSON Schema subset'))
    if (candidate.specHash !== job.specHash || candidate.toolId !== job.toolId ||
      !exactJson(candidate.manifest.inputSchema, job.spec.inputContract) ||
      !exactJson(candidate.manifest.outputSchema, job.spec.outputContract) ||
      !exactJson(candidate.manifest.permissions, job.spec.permissions)) {
      throw new Error('Candidate manifest does not match sealed ForgeJob spec')
    }
    facts.checks.set('spec-manifest-contract', check('spec-manifest-contract', 'passed', 'Candidate manifest matches sealed ForgeJob spec'))
    projectReadProfile(candidate)
    facts.checks.set('project-read-profile', check('project-read-profile', 'passed', 'Candidate stays inside gate2-project-read-v1'))
    suite = getGeneratedToolValidationSuite(candidate)
    source = readCandidateSource(jokerHome, candidate)
    facts.checks.set('entrypoint-load', check('entrypoint-load', 'passed', 'Candidate entrypoint is readable from immutable artifact'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const id = message.includes('changed after sealing') ? 'candidate-integrity-preflight'
      : message.includes('JSON Schema') || message.includes('schema') ? 'manifest-schema'
        : message.includes('spec') ? 'spec-manifest-contract'
          : message.includes('profile') || message.includes('capabilities') ? 'project-read-profile'
            : 'entrypoint-load'
    facts.checks.set(id, check(id, 'failed', message, undefined, id === 'candidate-integrity-preflight' || id === 'project-read-profile'))
  }

  if (runtimeQualified && suite && source && !signal?.aborted && ![...facts.checks.values()].some((item) => item.quarantine)) {
    for (const validationCase of suite.cases) {
      const workspacePath = workspaceForCase(jokerHome, job.id, job.validationRunId, validationCase.id, validationCase.workspaceFiles)
      const result = await runGeneratedTool({ manifest: candidate.manifest, source, workspacePath, input: validationCase.input, signal })
      if (result.outcome === 'cancelled') {
        const cancelled = updateForgeJob(jokerHome, job.id, job.revision, (current) => ({
          ...current,
          revision: current.revision + 1,
          status: 'cancelled',
          updatedAt: Date.now(),
          finishedAt: Date.now(),
          candidateId: undefined,
          candidateFingerprint: undefined,
          attemptRecordId: undefined,
          validationRunId: undefined,
          validationReportId: undefined,
          error: 'validation-cancelled'
        }))
        return { job: cancelled, outcome: 'cancelled' }
      }
      facts.results.push({ caseId: validationCase.id, expected: validationCase.expected, result })
    }
    const successCases = facts.results.filter((item) => (item.expected as { outcome: string }).outcome === 'succeeded')
    const failureCases = facts.results.filter((item) => (item.expected as { outcome: string }).outcome === 'tool-failed')
    facts.checks.set('acceptance-success', successCases.every((item) => item.result.outcome === 'succeeded' && exactJson(item.result.output, (item.expected as { output: unknown }).output))
      ? check('acceptance-success', 'passed', 'All expected-success cases matched exact outputs')
      : check('acceptance-success', 'failed', 'An expected-success case did not match'))
    facts.checks.set('acceptance-explicit-failure', failureCases.every((item) => item.result.outcome === 'tool-failed' && exactJson(item.result.error, (item.expected as { error: unknown }).error))
      ? check('acceptance-explicit-failure', 'passed', 'All expected-failure cases used tool.fail with exact errors')
      : check('acceptance-explicit-failure', 'failed', 'An expected-failure case did not use the required explicit failure'))
    const denied = facts.results.flatMap((item) => item.result.capabilityEvents).filter((event) => event.decision === 'denied')
    facts.checks.set('capability-conformance', denied.length === 0
      ? check('capability-conformance', 'passed', 'No denied broker capability attempts were observed', facts.results.map((item) => item.result.capabilityEvents))
      : check('capability-conformance', 'failed', 'Denied broker capability attempt was observed', denied, true))
    facts.checks.set('execution-budgets', facts.results.every((item) => !['timed-out', 'cancelled'].includes(item.result.outcome))
      ? check('execution-budgets', 'passed', 'All validation cases completed within enforced budgets')
      : check('execution-budgets', 'failed', 'A validation case exceeded execution budgets'))
  }

  try {
    verifyGeneratedToolCandidate(jokerHome, candidate)
    facts.checks.set('candidate-integrity-postflight', check('candidate-integrity-postflight', 'passed', 'Candidate fingerprint remained unchanged after validation'))
  } catch (error) {
    facts.checks.set('candidate-integrity-postflight', check('candidate-integrity-postflight', 'failed', error instanceof Error ? error.message : String(error), undefined, true))
  }

  for (const [id] of MANDATORY_GATE2_CHECKS) {
    if (!facts.checks.has(id)) facts.checks.set(id, check(id, 'skipped', 'Check was not safely executable'))
  }
  const checks = reportChecks(facts)
  const evidence = checks.map((item) => evidenceFor(item.id, facts.checks.get(item.id)!))
  const finishedAt = Date.now()
  const report = commitValidationReportBundle({
    jokerHome,
    report: {
      toolId: candidate.toolId,
      versionId: candidate.id,
      artifactFingerprint: candidate.artifactFingerprint,
      validationProfile: candidate.validationProfile,
      jobId: job.id,
      attempt: job.attempt,
      validationRunId: job.validationRunId,
      validationSuiteId: candidate.validationSuiteId,
      validationSuiteHash: candidate.validationSuiteHash,
      startedAt,
      finishedAt,
      status: deriveStatus(facts),
      checks,
      declaredPermissions: candidate.manifest.permissions,
      observedCapabilities: [...new Set(facts.results.flatMap((item) => item.result.observedCapabilities))]
    },
    evidence,
    logs: `${JSON.stringify({ jobId: job.id, candidateId: candidate.id, resultCount: facts.results.length })}\n`
  })
  const latestJob = readForgeJob(jokerHome, job.id)
  if (!latestJob || latestJob.revision !== job.revision || latestJob.status !== 'validating') throw new Error('ForgeJob changed before validation report attachment')
  return { report, job: attachTerminalReport(jokerHome, latestJob, report), outcome: 'completed' }
}
