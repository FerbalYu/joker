import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

export const GATE5_AUDIT_SCHEMA_VERSION = 1 as const

export interface Gate5AuditArtifact {
  path: string
  sha256: string
  bytes: number
  kind: string
  generatedAt?: string | number
  status: 'pass' | 'fail' | 'not-verified'
  checks: number
}

export interface Gate5CompatibilityRow {
  artifactPath: string
  artifactKind: string
  platform: string | null
  environment: string | null
  artifact: string | null
  status: 'pass' | 'fail' | 'not-verified'
  passedChecks: number
  failedChecks: number
  notVerifiedChecks: number
  checksum: string
}

export interface Gate5Section23CheckEvidence {
  groupId: string
  artifactPath: string
  checksum: string
  checkIds: string[]
}

export interface Gate5Section23EvidenceGroup {
  id: string
  requirement: string
  status: 'pass' | 'not-verified'
  evidence: Gate5Section23CheckEvidence[]
}

export interface Gate5Section23Evidence {
  id: string
  requirement: string
  status: 'pass' | 'partial' | 'not-verified'
  groups: Gate5Section23EvidenceGroup[]
  evidence: Gate5Section23CheckEvidence[]
  note?: string
}

export interface Gate5AuditReport {
  schemaVersion: typeof GATE5_AUDIT_SCHEMA_VERSION
  generatedAt: string
  sourceRoot: string
  artifactCount: number
  artifacts: Gate5AuditArtifact[]
  compatibilityMatrix: Gate5CompatibilityRow[]
  section23: Gate5Section23Evidence[]
  status: 'pass' | 'partial' | 'not-verified'
  limitations: string[]
}

interface ParsedArtifact {
  relativePath: string
  absolutePath: string
  value: Record<string, unknown>
  kind: string
  checksum: string
  bytes: number
}

type EvidencePattern = readonly string[]

interface Section23EvidenceGroupDefinition {
  id: string
  requirement: string
  patterns: readonly EvidencePattern[]
}

interface Section23RequirementDefinition {
  id: string
  requirement: string
  groups: readonly Section23EvidenceGroupDefinition[]
}

const JSON_ARTIFACT_DIRS = ['.qa', 'coverage']
const SECTION23_REQUIREMENTS = [
  {
    id: 'real-task-gap-and-forge',
    requirement: 'Real task capability-gap discovery and ToolForge invocation',
    groups: [
      { id: 'gap-discovery', requirement: 'A real task records capability-gap discovery', patterns: [['gap-discovery'], ['capability-gap'], ['missing-capability'], ['missing capability'], ['toolsearch', 'gap'], ['toolsearch', 'missing']] },
      { id: 'toolforge-invocation', requirement: 'The ToolForge meta-tool is actually invoked', patterns: [['toolforge-invocation'], ['toolforge-invoked'], ['toolforge invoked'], ['toolforgestart'], ['toolforge start'], ['forge-job-created'], ['forge job created']] }
    ]
  },
  {
    id: 'isolated-manufacturing',
    requirement: 'ForgeAgent manufacturing stays in an isolated job environment',
    groups: [
      { id: 'isolated-job-environment', requirement: 'Manufacturing executes in an isolated Forge job environment', patterns: [['isolated-job-environment'], ['isolated job environment'], ['manufacturing-isolation'], ['manufacturing isolation'], ['forgeagent', 'isolated job']] },
      { id: 'workspace-boundary', requirement: 'The manufacturing workspace and host boundary are enforced', patterns: [['workspace-boundary'], ['workspace boundary'], ['host-boundary'], ['host boundary'], ['undeclared file denied'], ['forgeagent host check']] }
    ]
  },
  {
    id: 'independent-validation',
    requirement: 'Validator independently verifies behavior, permissions, failure, and recovery',
    groups: [
      { id: 'independent-validator', requirement: 'Validation is performed independently from manufacturing', patterns: [['independent-validator'], ['independent validator'], ['independent-validation'], ['independent validation'], ['validator report']] },
      { id: 'behavior-validation', requirement: 'Expected successful behavior is validated', patterns: [['behavior-validation'], ['behavior validation'], ['acceptance-success'], ['expected-success cases'], ['exact outputs']] },
      { id: 'permission-validation', requirement: 'Declared and observed permissions are validated', patterns: [['permission-validation'], ['permission validation'], ['project-read-profile'], ['capability-conformance'], ['denied broker capability']] },
      { id: 'failure-validation', requirement: 'Expected failure behavior is validated', patterns: [['failure-validation'], ['failure validation'], ['acceptance-explicit-failure'], ['expected-failure cases'], ['tool.fail']] },
      { id: 'recovery-validation', requirement: 'Recovery behavior is validated', patterns: [['recovery-validation'], ['recovery validation'], ['recovery-check'], ['recovery fixture']] }
    ]
  },
  {
    id: 'policy-promotion',
    requirement: 'Low-risk Tool promotion follows host policy',
    groups: [
      { id: 'low-risk-policy', requirement: 'Low-risk eligibility is decided by host policy', patterns: [['low-risk-policy'], ['low risk policy'], ['policy-decision'], ['policy decision'], ['auto-eligible'], ['awaiting-policy'], ['awaiting policy']] },
      { id: 'promotion-result', requirement: 'The policy-approved candidate is promoted', patterns: [['promotion-result'], ['promotion succeeds'], ['promoted successfully'], ['action promoted'], ['toolpromote'], ['promotion recorded']] }
    ]
  },
  {
    id: 'hot-toolset-refresh',
    requirement: 'New Tool enters the ToolSet without an application restart',
    groups: [
      { id: 'no-restart-toolset-refresh', requirement: 'The ToolSet refreshes without an application restart', patterns: [['no-restart-toolset-refresh'], ['without restart'], ['no restart'], ['hot-toolset'], ['hot toolset'], ['hot-load'], ['hot load'], ['toolset refresh'], ['rebuilds toolset']] },
      { id: 'promoted-tool-active', requirement: 'The exact promoted Tool/version becomes active', patterns: [['promoted-tool-active'], ['exact promoted snapshot'], ['exact promoted generated tool'], ['v2 is active'], ['active version'], ['capability revision increments'], ['capability-revision']] }
    ]
  },
  {
    id: 'continuation-real-call',
    requirement: 'Original task continues and calls the new Tool',
    groups: [
      { id: 'continuation-resume', requirement: 'The original task continuation resumes', patterns: [['continuation-resume'], ['continuation resumes'], ['original task continues'], ['automatic continuation'], ['continuation rebuilds'], ['continuation claimed']] },
      { id: 'generated-tool-real-call', requirement: 'The continuation makes a real call to the generated Tool', patterns: [['generated-tool-real-call'], ['real-tool-call'], ['generated tool first call'], ['generated-tool-first-call'], ['real generated tool call'], ['generated tool invoked'], ['invocation outcome succeeded']] }
    ]
  },
  {
    id: 'conversation-settings-explainability',
    requirement: 'Conversation and settings explain Tool purpose, state, permissions, and evidence',
    groups: [
      { id: 'conversation-explainability', requirement: 'Conversation UI exposes Tool explanation', patterns: [['conversation-explainability'], ['conversation explains'], ['conversation shows tool'], ['conversation tool evidence']] },
      { id: 'settings-explainability', requirement: 'Settings UI exposes Tool explanation', patterns: [['settings-explainability'], ['settings explains'], ['settings shows tool'], ['generated tools settings']] },
      { id: 'purpose-state-explanation', requirement: 'Purpose and current state are explained', patterns: [['purpose-state-explanation'], ['purpose and state'], ['purpose status'], ['tool purpose'], ['tool state']] },
      { id: 'permissions-evidence-explanation', requirement: 'Permissions and retained evidence are explained', patterns: [['permissions-evidence-explanation'], ['permissions and evidence'], ['permission summary'], ['validation report'], ['evidence link']] }
    ]
  },
  {
    id: 'targeted-natural-language-edit',
    requirement: 'User can select a specific Tool and edit it with natural language',
    groups: [
      { id: 'targeted-tool-selection', requirement: 'The edit targets a selected, specific Tool', patterns: [['targeted-tool-selection'], ['selected tool'], ['specific tool'], ['targeted tool']] },
      { id: 'natural-language-edit', requirement: 'A natural-language edit request is executed', patterns: [['natural-language-edit'], ['natural language edit'], ['edit instruction'], ['user edit request']] }
    ]
  },
  {
    id: 'failed-edit-and-invalidation',
    requirement: 'Failed edits preserve the stable version and permission or content changes invalidate it',
    groups: [
      { id: 'failed-edit-preserves-stable', requirement: 'A failed edit preserves the prior active stable version', patterns: [['failed-edit-preserves-stable'], ['failed edit preserves'], ['old stable version'], ['v1 remains active'], ['last-stable pointers'], ['last stable']] },
      { id: 'permission-change-invalidation', requirement: 'A permission change automatically invalidates the Tool', patterns: [['permission-change-invalidation'], ['permission change invalidates'], ['permissions changed invalidates'], ['permission expansion invalidates']] },
      { id: 'content-change-invalidation', requirement: 'A content change automatically invalidates the Tool', patterns: [['content-change-invalidation'], ['content change invalidates'], ['artifact change invalidates'], ['fingerprint change invalidates'], ['integrity invalidated']] }
    ]
  },
  {
    id: 'lifecycle-and-restart-recovery',
    requirement: 'Tool lifecycle operations and restart recovery are supported',
    groups: [
      { id: 'lifecycle-deactivate', requirement: 'The Tool can be deactivated', patterns: [['lifecycle-deactivate'], ['tool deactivation'], ['tool deactivated'], ['disable tool']] },
      { id: 'lifecycle-revalidate', requirement: 'The Tool can be revalidated', patterns: [['lifecycle-revalidate'], ['tool revalidation'], ['tool revalidated'], ['revalidate tool']] },
      { id: 'lifecycle-rollback', requirement: 'The Tool can be rolled back', patterns: [['lifecycle-rollback'], ['tool rollback'], ['rolled back'], ['rollback succeeds']] },
      { id: 'lifecycle-delete', requirement: 'The Tool can be deleted', patterns: [['lifecycle-delete'], ['tool deletion'], ['tool deleted'], ['delete tool']] },
      { id: 'restart-recovery', requirement: 'Tool state and operation recover after restart', patterns: [['restart-recovery'], ['restart recovery'], ['restart persistence'], ['restored after restart'], ['survives restart']] }
    ]
  },
  {
    id: 'deterministic-security-and-race-tests',
    requirement: 'Overreach, false success, duplicate continuation, concurrent edits, and half-switches have deterministic tests',
    groups: [
      { id: 'security-overreach', requirement: 'Overreach is deterministically denied', patterns: [['security-overreach'], ['overreach denied'], ['workspace-boundary'], ['network-denied'], ['subprocess-denied'], ['env-denied'], ['ipc-registry-audit-isolation']] },
      { id: 'fake-success', requirement: 'False or fake success is deterministically rejected', patterns: [['fake-success'], ['fake success'], ['false-success'], ['false success']] },
      { id: 'duplicate-continuation', requirement: 'Duplicate continuation is deterministically blocked', patterns: [['duplicate-continuation'], ['duplicate continuation'], ['continuation-duplicate-blocked']] },
      { id: 'concurrent-modification', requirement: 'Concurrent modification races are deterministically handled', patterns: [['concurrent-modification'], ['concurrent modification'], ['concurrency edit'], ['race test'], ['race-test']] },
      { id: 'half-switch', requirement: 'Half-switched active/stable state is deterministically prevented', patterns: [['half-switch'], ['half switch'], ['half-switched'], ['partial switch']] }
    ]
  }
] as const satisfies readonly Section23RequirementDefinition[]

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function walkJsonFiles(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return walkJsonFiles(path)
    return entry.isFile() && entry.name.endsWith('.json') ? [path] : []
  })
}

function artifactKind(relativePath: string, value: Record<string, unknown>): string {
  const name = relativePath.toLowerCase()
  if (name.includes('native-package')) return 'native-package'
  if (name.includes('signed-release')) return 'signed-release'
  if (name.includes('release-boundary')) return 'release-boundary'
  if (name.includes('runtime-qualification')) return 'runtime-qualification'
  if (name.includes('toolforge')) return 'toolforge-qualification'
  if (Array.isArray(value.checks)) return 'qualification-checks'
  return 'retained-qa'
}

function runtimeQualificationStatus(value: Record<string, unknown>): 'pass' | 'fail' | 'not-verified' | null {
  const environments = value.environments
  const candidates = value.candidates
  if (value.level !== 'L2' || !environments || typeof environments !== 'object' || !Array.isArray(candidates)) return null
  const environmentValues = Object.values(environments as Record<string, unknown>)
  const authoritativeCandidates = candidates.filter((candidate) => candidate && typeof candidate === 'object'
    && (candidate as Record<string, unknown>).candidate === 'quickjs-wasm'
    && (candidate as Record<string, unknown>).passesIsolation === true) as Array<Record<string, unknown>>
  if (environmentValues.some((environment) => environment && typeof environment === 'object'
    && ((environment as Record<string, unknown>).status === 'failed' || (environment as Record<string, unknown>).status === 'fail'))) return 'fail'
  if (authoritativeCandidates.some((candidate) => Array.isArray(candidate.cases) && candidate.cases.some((item) => item && typeof item === 'object'
    && ((item as Record<string, unknown>).status === 'fail' || (item as Record<string, unknown>).status === 'failed')))) return 'fail'
  const environmentsPassed = environmentValues.length > 0 && environmentValues.every((environment) => environment && typeof environment === 'object'
    && ((environment as Record<string, unknown>).status === 'passed' || (environment as Record<string, unknown>).status === 'pass'))
  const authoritativePassed = authoritativeCandidates.length > 0 && authoritativeCandidates.every((candidate) => Array.isArray(candidate.cases)
    && candidate.cases.length > 0
    && candidate.cases.every((item) => item && typeof item === 'object'
      && ((item as Record<string, unknown>).status === 'pass' || (item as Record<string, unknown>).status === 'passed')))
  return environmentsPassed && authoritativePassed ? 'pass' : 'not-verified'
}

function statusFor(value: Record<string, unknown>): 'pass' | 'fail' | 'not-verified' {
  const runtimeStatus = runtimeQualificationStatus(value)
  if (runtimeStatus) return runtimeStatus
  const summary = value.statusSummary
  if (summary && typeof summary === 'object') {
    const counts = summary as Record<string, unknown>
    if (Number(counts.fail) > 0) return 'fail'
    if (Number(counts['not-verified']) > 0 || Number(counts['contract-gap']) > 0) return 'not-verified'
    if (Number(counts.pass) > 0) return 'pass'
  }
  if (value.passed === true || value.status === 'passed' || value.status === 'pass' || value.readSucceeded === true) return 'pass'
  if (value.passed === false || value.status === 'failed' || value.status === 'fail') return 'fail'
  return 'not-verified'
}

type EvidenceCheck = { id: string; text: string; status: 'pass' | 'fail' | 'not-verified' }

type RetainedEvidenceCheck = EvidenceCheck & {
  artifactPath: string
  checksum: string
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function checkStatus(value: Record<string, unknown>): EvidenceCheck['status'] {
  if (value.status === 'pass' || value.status === 'passed' || value.pass === true) return 'pass'
  if (value.status === 'fail' || value.status === 'failed' || value.pass === false) return 'fail'
  return 'not-verified'
}

function semanticText(value: Record<string, unknown>, fields: readonly string[]): string {
  return fields.flatMap((field) => {
    const item = value[field]
    return typeof item === 'string' && item.trim() ? [item.trim()] : []
  }).join(' ')
}

function directEvidenceChecks(value: Record<string, unknown>): EvidenceCheck[] {
  const checks: EvidenceCheck[] = []
  if (Array.isArray(value.checks)) {
    for (const item of value.checks) {
      if (!item || typeof item !== 'object') continue
      const check = item as Record<string, unknown>
      const id = typeof check.id === 'string' ? check.id : typeof check.name === 'string' ? slug(check.name) : ''
      if (!id) continue
      checks.push({
        id,
        text: `${id} ${semanticText(check, ['name', 'expected', 'requirement', 'description'])}`,
        status: checkStatus(check)
      })
    }
  }
  if (Array.isArray(value.candidates)) {
    for (const candidateValue of value.candidates) {
      if (!candidateValue || typeof candidateValue !== 'object') continue
      const candidate = candidateValue as Record<string, unknown>
      // passesIsolation:false candidates are expected-negative harness controls, not §23 evidence.
      if (candidate.candidate !== 'quickjs-wasm' || candidate.passesIsolation !== true || !Array.isArray(candidate.cases)) continue
      for (const caseValue of candidate.cases) {
        if (!caseValue || typeof caseValue !== 'object') continue
        const item = caseValue as Record<string, unknown>
        const caseId = typeof item.id === 'string' ? item.id : ''
        if (!caseId) continue
        const environment = typeof candidate.env === 'string' ? candidate.env : 'environment'
        const id = `quickjs-wasm.${environment}.${caseId}`
        checks.push({ id, text: `${id} ${typeof item.details === 'string' ? item.details : ''}`, status: checkStatus(item) })
      }
    }
  }
  if (Array.isArray(value.scenarios)) {
    for (const scenarioValue of value.scenarios) {
      if (!scenarioValue || typeof scenarioValue !== 'object') continue
      const scenario = scenarioValue as Record<string, unknown>
      const scenarioId = typeof scenario.scenario === 'string' ? scenario.scenario : ''
      if (!scenarioId) continue
      checks.push({
        id: `${typeof value.qualification === 'string' ? value.qualification : 'qualification'}.${scenarioId}`,
        text: `${scenarioId} ${semanticText(scenario, ['name', 'requirement', 'description', 'expected'])}`,
        status: checkStatus(scenario)
      })
    }
  }
  return checks
}

function matchesGroup(check: RetainedEvidenceCheck, group: Section23EvidenceGroupDefinition): boolean {
  const text = `${check.id} ${check.text}`.toLowerCase()
  return group.patterns.some((pattern) => pattern.every((term) => text.includes(term)))
}

function assignDistinctChecksToGroups(groups: readonly Section23EvidenceGroupDefinition[], checks: RetainedEvidenceCheck[]): Array<RetainedEvidenceCheck | null> {
  const checkToGroup = new Map<number, number>()
  const candidates = groups.map((group) => checks.flatMap((check, index) => matchesGroup(check, group) ? [index] : []))
  const assign = (groupIndex: number, visitedChecks: Set<number>): boolean => {
    for (const checkIndex of candidates[groupIndex]) {
      if (visitedChecks.has(checkIndex)) continue
      visitedChecks.add(checkIndex)
      const previousGroup = checkToGroup.get(checkIndex)
      if (previousGroup === undefined || assign(previousGroup, visitedChecks)) {
        checkToGroup.set(checkIndex, groupIndex)
        return true
      }
    }
    return false
  }
  groups.forEach((_, groupIndex) => assign(groupIndex, new Set()))
  const assigned: Array<RetainedEvidenceCheck | null> = groups.map(() => null)
  for (const [checkIndex, groupIndex] of checkToGroup) assigned[groupIndex] = checks[checkIndex]
  return assigned
}

function checkStats(value: Record<string, unknown>): { passed: number; failed: number; notVerified: number; total: number } {
  const checks = directEvidenceChecks(value)
  const passed = checks.filter((check) => check.status === 'pass').length
  const failed = checks.filter((check) => check.status === 'fail').length
  const notVerified = checks.length - passed - failed
  return { passed, failed, notVerified, total: checks.length }
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key]
  return typeof field === 'string' && field.trim() ? field : null
}

export function collectRetainedQualificationArtifacts(sourceRoot: string): ParsedArtifact[] {
  const root = resolve(sourceRoot)
  const paths = JSON_ARTIFACT_DIRS.flatMap((directory) => walkJsonFiles(join(root, directory)))
    .filter((path) => !path.endsWith('/gate5-audit-report.json') && !path.endsWith('\\gate5-audit-report.json'))
  return paths.sort().flatMap((absolutePath) => {
    try {
      const value = JSON.parse(readFileSync(absolutePath, 'utf8')) as unknown
      if (!value || typeof value !== 'object' || Array.isArray(value)) return []
      return [{
        relativePath: relative(root, absolutePath).replaceAll('\\', '/'),
        absolutePath,
        value: value as Record<string, unknown>,
        kind: artifactKind(relative(root, absolutePath).replaceAll('\\', '/'), value as Record<string, unknown>),
        checksum: sha256(absolutePath),
        bytes: statSync(absolutePath).size
      }]
    } catch {
      return []
    }
  })
}

export function generateGate5AuditReport(sourceRoot: string): Gate5AuditReport {
  const root = resolve(sourceRoot)
  const parsed = collectRetainedQualificationArtifacts(root)
  const artifacts: Gate5AuditArtifact[] = parsed.map((item) => {
    const stats = checkStats(item.value)
    return {
      path: item.relativePath,
      sha256: item.checksum,
      bytes: item.bytes,
      kind: item.kind,
      generatedAt: typeof item.value.generatedAt === 'string' || typeof item.value.generatedAt === 'number' ? item.value.generatedAt : undefined,
      status: statusFor(item.value),
      checks: stats.total
    }
  })
  const compatibilityMatrix: Gate5CompatibilityRow[] = parsed.map((item) => {
    const stats = checkStats(item.value)
    const artifact = item.value.artifact
    return {
      artifactPath: item.relativePath,
      artifactKind: item.kind,
      platform: stringField(item.value, 'platform'),
      environment: stringField(item.value, 'environment') ?? (item.kind === 'native-package' ? 'packaged' : null),
      artifact: artifact && typeof artifact === 'object' ? stringField(artifact as Record<string, unknown>, 'path') : null,
      status: statusFor(item.value),
      passedChecks: stats.passed,
      failedChecks: stats.failed,
      notVerifiedChecks: stats.notVerified,
      checksum: item.checksum
    }
  })
  const passedChecks: RetainedEvidenceCheck[] = parsed.flatMap((item) => directEvidenceChecks(item.value)
    .filter((check) => check.status === 'pass')
    .map((check) => ({ ...check, artifactPath: item.relativePath, checksum: item.checksum })))
  const section23: Gate5Section23Evidence[] = SECTION23_REQUIREMENTS.map((requirement) => {
    const assignments = assignDistinctChecksToGroups(requirement.groups, passedChecks)
    const groups: Gate5Section23EvidenceGroup[] = requirement.groups.map((group, index) => {
      const check = assignments[index]
      const evidence = check ? [{ groupId: group.id, artifactPath: check.artifactPath, checksum: check.checksum, checkIds: [check.id] }] : []
      return { id: group.id, requirement: group.requirement, status: check ? 'pass' as const : 'not-verified' as const, evidence }
    })
    const evidence = groups.flatMap((group) => group.evidence)
    const verifiedGroups = groups.filter((group) => group.status === 'pass').length
    const missingGroups = groups.filter((group) => group.status === 'not-verified').map((group) => group.id)
    return {
      id: requirement.id,
      requirement: requirement.requirement,
      status: verifiedGroups === groups.length ? 'pass' : verifiedGroups > 0 ? 'partial' : 'not-verified',
      groups,
      evidence,
      ...(missingGroups.length > 0 ? { note: `Missing retained passed direct checks for evidence groups: ${missingGroups.join(', ')}.` } : {})
    }
  })
  const passCount = section23.filter((item) => item.status === 'pass').length
  const hasPartialEvidence = section23.some((item) => item.status === 'partial')
  return {
    schemaVersion: GATE5_AUDIT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    sourceRoot: root,
    artifactCount: artifacts.length,
    artifacts,
    compatibilityMatrix,
    section23,
    status: passCount === section23.length ? 'pass' : passCount > 0 || hasPartialEvidence ? 'partial' : 'not-verified',
    limitations: [
      'Only retained JSON artifacts under .qa/ and coverage/ are considered; transient logs and unretained run directories are excluded.',
      'Every §23 evidence group requires its own retained passed direct check; top-level passed flags, report summaries, broad keywords, and a single check reused across groups are not claim evidence.',
      'Expected-negative runtime controls with passesIsolation:false are excluded from §23 evidence and do not override authoritative QuickJS L2 runtime status.',
      'Requirements with no verified groups remain not-verified; requirements missing any group remain partial and are never inferred from UI smoke output.'
    ]
  }
}
