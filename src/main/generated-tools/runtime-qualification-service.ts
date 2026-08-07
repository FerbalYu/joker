import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { GeneratedToolManifestSchema } from '../../shared/generated-tools-schema'
import type {
  RuntimeQualificationCaseId,
  RuntimeQualificationCaseResult,
  RuntimeQualificationReport
} from '../../shared/generated-tools'
import {
  deriveRuntimeLevel,
  runtimeQualificationFileIdentity,
  validateRuntimeQualificationReportEvidence,
  writeRuntimeQualificationReport
} from './qualification'
import {
  readQualificationOperation,
  writeQualificationOperation,
  type QualificationOperationRecord
} from './qualification-operation-store'
import { runGeneratedTool } from './runtime/runner'

const TOTAL_CHECKS = 8
const EXPECTED_OUTPUT = 'open: 4\ndone: 3\nin_progress: 2'
const CASES: RuntimeQualificationCaseId[] = [
  'legit-execution',
  'workspace-boundary',
  'network-denied',
  'subprocess-denied',
  'env-denied',
  'timeout-cleanup',
  'cancel-cleanup',
  'ipc-registry-audit-isolation'
]

export interface QualificationServiceOptions {
  jokerHome: string
  fixtureRoot?: string
  now?: () => number
  createId?: () => string
}

function fixtureRootFor(options: QualificationServiceOptions): string {
  if (options.fixtureRoot) return resolve(options.fixtureRoot)
  const configured = process.env['JOKER_TOOLFORGE_FIXTURE_ROOT']?.trim()
  if (configured) return resolve(configured)
  const packaged = typeof process.resourcesPath === 'string'
    ? join(process.resourcesPath, 'toolforge-fixture')
    : ''
  if (packaged && existsSync(packaged)) return packaged
  return resolve(process.cwd(), 'scripts', 'fixtures', 'generated-tools', 'summarize-task-json')
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[A-Za-z]:[\\/][^\s;,)]+/g, '[path]').slice(0, 2_000)
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

function reportCase(
  id: RuntimeQualificationCaseId,
  passed: boolean,
  details: string,
  evidence: RuntimeQualificationCaseResult['evidence']
): RuntimeQualificationCaseResult {
  return { id, status: passed ? 'pass' : 'fail', details: details.slice(0, 16_000), evidence }
}

function projectArtifactIdentity(): RuntimeQualificationReport['artifactIdentity'] {
  const root = resolve(process.cwd())
  const quickjsPackage = resolve(root, 'node_modules', 'quickjs-emscripten', 'package.json')
  const quickjsVersion = (JSON.parse(readFileSync(quickjsPackage, 'utf8')) as { version?: string }).version
  if (!quickjsVersion) throw new Error('quickjs-emscripten package version is missing')
  return {
    bundle: runtimeQualificationFileIdentity(resolve(root, 'out', 'main', 'index.js'), root),
    worker: runtimeQualificationFileIdentity(resolve(root, 'out', 'main', 'generated-tool-worker.js'), root),
    quickjsPackage: { ...runtimeQualificationFileIdentity(quickjsPackage, root), version: quickjsVersion },
    packageLock: runtimeQualificationFileIdentity(resolve(root, 'package-lock.json'), root)
  }
}

function workspacePath(jokerHome: string, attemptId: string): string {
  return join(jokerHome, '.joker', 'qualification', 'workspace', attemptId)
}

function updateOperation(
  options: QualificationServiceOptions,
  attemptId: string,
  update: (current: QualificationOperationRecord) => QualificationOperationRecord
): QualificationOperationRecord {
  const current = readQualificationOperation(options.jokerHome)
  if (!current || current.attemptId !== attemptId) throw new Error('Qualification attempt is no longer active')
  return writeQualificationOperation(update(current), options.jokerHome)
}

export class RuntimeQualificationService {
  private readonly now: () => number
  private readonly createId: () => string
  private readonly active = new Map<string, AbortController>()

  constructor(private readonly options: QualificationServiceOptions) {
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? randomUUID
  }

  recover(): QualificationOperationRecord | null {
    const current = readQualificationOperation(this.options.jokerHome)
    if (!current || !['queued', 'running'].includes(current.status)) return current
    return writeQualificationOperation({
      ...current,
      status: 'interrupted',
      phase: 'interrupted',
      updatedAt: this.now(),
      finishedAt: this.now(),
      error: 'qualification-service-stopped'
    }, this.options.jokerHome)
  }

  status(): QualificationOperationRecord | null {
    return readQualificationOperation(this.options.jokerHome)
  }

  stop(): void {
    for (const controller of this.active.values()) controller.abort()
    this.active.clear()
  }

  start(): QualificationOperationRecord {
    const current = readQualificationOperation(this.options.jokerHome)
    if (current && ['queued', 'running'].includes(current.status)) return current
    const attemptId = `qualification-${this.createId()}`.slice(0, 128)
    const queued: QualificationOperationRecord = {
      schemaVersion: 1,
      attemptId,
      status: 'queued',
      phase: 'queued',
      completedChecks: 0,
      totalChecks: TOTAL_CHECKS,
      updatedAt: this.now()
    }
    writeQualificationOperation(queued, this.options.jokerHome)
    const controller = new AbortController()
    this.active.set(attemptId, controller)
    void this.run(attemptId, controller.signal).finally(() => this.active.delete(attemptId))
    return queued
  }

  cancel(): QualificationOperationRecord | null {
    const current = readQualificationOperation(this.options.jokerHome)
    if (!current) return null
    if (!['queued', 'running'].includes(current.status)) return current
    this.active.get(current.attemptId)?.abort()
    const cancelled: QualificationOperationRecord = {
      ...current,
      status: 'cancelled',
      phase: 'cancelled',
      updatedAt: this.now(),
      finishedAt: this.now(),
      error: 'cancelled-by-user'
    }
    return writeQualificationOperation(cancelled, this.options.jokerHome)
  }

  private async run(attemptId: string, signal: AbortSignal): Promise<void> {
    try {
      updateOperation(this.options, attemptId, (current) => ({
        ...current,
        status: 'running',
        phase: 'preparing',
        startedAt: this.now(),
        updatedAt: this.now()
      }))
      const root = fixtureRootFor(this.options)
      const manifest = GeneratedToolManifestSchema.parse(JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')))
      const source = readFileSync(join(root, manifest.entrypoint), 'utf8')
      const tasks = JSON.stringify([
        { id: 1, status: 'open' },
        { id: 2, status: 'open' },
        { id: 3, status: 'open' },
        { id: 4, status: 'open' },
        { id: 5, status: 'done' },
        { id: 6, status: 'done' },
        { id: 7, status: 'done' },
        { id: 8, status: 'in_progress' },
        { id: 9, status: 'in_progress' }
      ])
      const workspace = workspacePath(this.options.jokerHome, attemptId)
      mkdirSync(join(workspace, 'fixtures'), { recursive: true })
      writeFileSync(join(workspace, 'fixtures', 'tasks.json'), tasks, 'utf8')
      const secretPath = join(this.options.jokerHome, '.joker', 'qualification', 'workspace', 'secret.txt')
      writeFileSync(secretPath, 'QUALIFICATION-OUTSIDE-WORKSPACE', 'utf8')
      const cases: RuntimeQualificationCaseResult[] = []
      const evidenceRoot = join(this.options.jokerHome, '.joker', 'qualification', 'evidence', attemptId)
      mkdirSync(evidenceRoot, { recursive: true })

      for (const id of CASES) {
        if (signal.aborted) throw new QualificationCancelledError()
        updateOperation(this.options, attemptId, (current) => ({
          ...current,
          phase: id,
          updatedAt: this.now()
        }))
        const result = await this.runCase(id, manifest, source, workspace, signal)
        const evidenceRelativePath = `evidence/${attemptId}/${id}.json`
        const evidencePath = join(this.options.jokerHome, '.joker', 'qualification', evidenceRelativePath)
        writeFileSync(evidencePath, `${JSON.stringify({ id, ...result }, null, 2)}\n`, 'utf8')
        cases.push(reportCase(
          id,
          result.passed,
          result.details,
          runtimeQualificationFileIdentity(
            evidencePath,
            join(this.options.jokerHome, '.joker', 'qualification')
          )
        ))
        updateOperation(this.options, attemptId, (current) => ({
          ...current,
          completedChecks: current.completedChecks + 1,
          updatedAt: this.now()
        }))
      }

      const startedAt = readQualificationOperation(this.options.jokerHome)?.startedAt ?? this.now()
      const reportInput: RuntimeQualificationReport = {
        schemaVersion: 2,
        generatedAt: this.now(),
        level: 'L0',
        artifactIdentity: projectArtifactIdentity(),
        environments: {
          dev: { environment: 'dev', status: cases.every((item) => item.status === 'pass') ? 'passed' : 'failed', startedAt, finishedAt: this.now() },
          packaged: { environment: 'packaged', status: 'incomplete', startedAt, finishedAt: this.now(), error: 'local host verification does not certify a packaged release' }
        },
        candidates: [{ candidate: 'quickjs-wasm', env: 'dev', passesIsolation: cases.every((item) => item.status === 'pass'), cases }],
        limitations: [
          'local host verification qualifies the current development runtime at L1 only',
          'packaged release equivalence requires the release qualification pipeline'
        ]
      }
      const report = { ...reportInput, level: deriveRuntimeLevel(reportInput) }
      const qualificationPath = join(this.options.jokerHome, '.joker', 'qualification', 'runtime-qualification.json')
      const validated = validateRuntimeQualificationReportEvidence(report, qualificationPath)
      writeRuntimeQualificationReport(validated, this.options.jokerHome)
      updateOperation(this.options, attemptId, (current) => ({
        ...current,
        status: 'completed',
        phase: 'completed',
        updatedAt: this.now(),
        finishedAt: this.now()
      }))
    } catch (error) {
      const cancelled = error instanceof QualificationCancelledError || signal.aborted
      const current = readQualificationOperation(this.options.jokerHome)
      if (!current || current.attemptId !== attemptId) return
      writeQualificationOperation({
        ...current,
        status: cancelled ? 'cancelled' : 'failed',
        phase: cancelled ? 'cancelled' : 'failed',
        updatedAt: this.now(),
        finishedAt: this.now(),
        error: cancelled ? 'cancelled-by-user' : errorMessage(error)
      }, this.options.jokerHome)
    }
  }

  private async runCase(
    id: RuntimeQualificationCaseId,
    manifest: import('../../shared/generated-tools').GeneratedToolManifest,
    source: string,
    workspace: string,
    signal: AbortSignal
  ): Promise<{ passed: boolean; details: string }> {
    if (id === 'legit-execution') {
      const result = await runGeneratedTool({ manifest, source, workspacePath: workspace, input: {}, signal })
      return { passed: result.ok && result.output === EXPECTED_OUTPUT, details: JSON.stringify(result) }
    }
    if (id === 'workspace-boundary') {
      const attempts = await Promise.all(['fixtures/undeclared.txt', '../secret.txt'].map((path) => runGeneratedTool({ manifest, source: `tool.output(tool.readFile(${JSON.stringify(path)}))`, workspacePath: workspace, input: {}, signal })))
      const hostProbe = await runGeneratedTool({ manifest, source: "let visible = false; try { const host = ({}).constructor.constructor('return process')(); visible = Boolean(host && host.versions) } catch {} tool.output(visible ? 'host-visible' : 'host-denied')", workspacePath: workspace, input: {}, signal })
      return {
        passed: attempts.every((item) => !item.ok && errorCode(item.error) === 'generated-tool-filesystem-undeclared-file')
          && hostProbe.output === 'host-denied',
        details: JSON.stringify({ attempts, hostProbe })
      }
    }
    if (id === 'network-denied') {
      const result = await runGeneratedTool({ manifest, source: 'tool.output(typeof fetch + ":" + typeof WebSocket)', workspacePath: workspace, input: {}, signal })
      return { passed: result.output === 'undefined:undefined', details: JSON.stringify(result) }
    }
    if (id === 'subprocess-denied') {
      const result = await runGeneratedTool({ manifest, source: 'tool.output(typeof process + ":" + typeof require)', workspacePath: workspace, input: {}, signal })
      return { passed: result.output === 'undefined:undefined', details: JSON.stringify(result) }
    }
    if (id === 'env-denied') {
      const result = await runGeneratedTool({ manifest, source: 'tool.output(typeof process + ":" + typeof Deno)', workspacePath: workspace, input: {}, signal })
      return { passed: result.output === 'undefined:undefined', details: JSON.stringify(result) }
    }
    if (id === 'timeout-cleanup') {
      const timed = await runGeneratedTool({ manifest: { ...manifest, limits: { ...manifest.limits, timeoutMs: 50 } }, source: 'while (true) {}', workspacePath: workspace, input: {}, signal })
      const followUp = await runGeneratedTool({ manifest, source: 'tool.output("alive")', workspacePath: workspace, input: {}, signal })
      return { passed: timed.terminatedByBudget && followUp.output === 'alive', details: JSON.stringify({ timed, followUp }) }
    }
    if (id === 'cancel-cleanup') {
      const controller = new AbortController()
      const pending = runGeneratedTool({ manifest, source: 'while (true) {}', workspacePath: workspace, input: {}, signal: controller.signal })
      setTimeout(() => controller.abort(), 20)
      const cancelled = await pending
      const followUp = await runGeneratedTool({ manifest, source: 'tool.output("alive")', workspacePath: workspace, input: {}, signal })
      return { passed: cancelled.terminatedByBudget && followUp.output === 'alive', details: JSON.stringify({ cancelled, followUp }) }
    }
    const result = await runGeneratedTool({ manifest, source: 'tool.output([typeof process, typeof require, typeof electron, typeof window, typeof global].join(":"))', workspacePath: workspace, input: {}, signal })
    return { passed: result.output === 'undefined:undefined:undefined:undefined:undefined', details: JSON.stringify(result) }
  }
}

export class QualificationCancelledError extends Error {
  constructor() {
    super('qualification-cancelled')
  }
}
