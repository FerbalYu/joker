import { createHash } from 'node:crypto'
import { app } from 'electron'
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

import type { RuntimeQualificationCaseResult } from '../../../shared/generated-tools'
import { GeneratedToolManifestSchema } from '../../../shared/generated-tools-schema'
import { runGeneratedTool } from './runner'

const EXPECTED_OUTPUT = 'open: 4\ndone: 3\nin_progress: 2'

function evidenceIdentity(path: string, root: string): NonNullable<RuntimeQualificationCaseResult['evidence']> {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('packaged qualification evidence must be a regular non-symlink file')
  const rel = relative(resolve(root), resolve(path))
  if (!rel || rel.startsWith('..')) throw new Error('packaged qualification evidence escaped its report root')
  return {
    path: rel.split(sep).join('/'),
    size: stat.size,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex')
  }
}

function pass(id: RuntimeQualificationCaseResult['id'], details: string, evidence: NonNullable<RuntimeQualificationCaseResult['evidence']>): RuntimeQualificationCaseResult {
  return { id, status: 'pass', details, evidence }
}

function fail(id: RuntimeQualificationCaseResult['id'], details: string): RuntimeQualificationCaseResult {
  return { id, status: 'fail', details }
}

function runtimeErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

/**
 * Narrow packaged-app qualification mode. It runs only when explicitly enabled
 * through environment variables and exits before normal IPC/window startup.
 */
export async function runPackagedGeneratedToolQualification(): Promise<boolean> {
  if (process.env['JOKER_PACKAGED_TOOL_QUALIFICATION'] !== '1') return false
  const reportPath = process.env['JOKER_PACKAGED_TOOL_REPORT']
  const workspacePath = process.env['JOKER_PACKAGED_TOOL_WORKSPACE']
  if (!reportPath || !workspacePath) throw new Error('Missing packaged Tool qualification paths')
  const outputReportPath = reportPath

  const fixtureRoot = join(process.resourcesPath, 'toolforge-fixture')
  const manifest = GeneratedToolManifestSchema.parse(
    JSON.parse(readFileSync(join(fixtureRoot, 'manifest.json'), 'utf8'))
  )
  const source = readFileSync(join(fixtureRoot, manifest.entrypoint), 'utf8')
  const evidenceDir = join(dirname(reportPath), 'evidence-packaged')
  mkdirSync(evidenceDir, { recursive: true })
  const startedAt = Date.now()
  const cases: RuntimeQualificationCaseResult[] = []

  async function record(
    id: RuntimeQualificationCaseResult['id'],
    run: () => Promise<{ passed: boolean; details: string }>
  ): Promise<void> {
    try {
      const result = await run()
      const evidenceRelativePath = `evidence-packaged/quickjs-wasm-${id}.json`
      const evidencePath = join(dirname(outputReportPath), evidenceRelativePath)
      writeFileSync(evidencePath, `${JSON.stringify({ id, ...result }, null, 2)}\n`, 'utf8')
      const evidence = evidenceIdentity(evidencePath, dirname(outputReportPath))
      cases.push(result.passed ? pass(id, result.details, evidence) : { ...fail(id, result.details), evidence })
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error)
      const evidenceRelativePath = `evidence-packaged/quickjs-wasm-${id}.json`
      const evidencePath = join(dirname(outputReportPath), evidenceRelativePath)
      writeFileSync(
        evidencePath,
        `${JSON.stringify({ id, passed: false, details }, null, 2)}\n`,
        'utf8'
      )
      cases.push({ ...fail(id, details), evidence: evidenceIdentity(evidencePath, dirname(outputReportPath)) })
    }
  }

  await record('legit-execution', async () => {
    const result = await runGeneratedTool({ manifest, source, workspacePath, input: {} })
    return { passed: result.ok && result.output === EXPECTED_OUTPUT, details: JSON.stringify(result) }
  })
  await record('workspace-boundary', async () => {
    const attempts = await Promise.all(['fixtures/undeclared.txt', '../secret.txt'].map((path) => runGeneratedTool({
      manifest,
      source: `tool.output(tool.readFile(${JSON.stringify(path)}))`,
      workspacePath,
      input: {}
    })))
    const hostProbe = await runGeneratedTool({
      manifest,
      source: `
        let visible = false
        try {
          const host = ({}).constructor.constructor('return process')()
          visible = Boolean(host && host.versions && host.versions.electron)
        } catch {}
        tool.output(visible ? 'host-visible' : 'host-denied')
      `,
      workspacePath,
      input: {}
    })
    return {
      passed: attempts.every((item) => !item.ok && runtimeErrorCode(item.error) === 'generated-tool-filesystem-undeclared-file')
        && hostProbe.output === 'host-denied',
      details: JSON.stringify({ attempts, hostProbe })
    }
  })
  await record('network-denied', async () => {
    const result = await runGeneratedTool({ manifest, source: 'tool.output(typeof fetch + ":" + typeof WebSocket)', workspacePath, input: {} })
    return { passed: result.output === 'undefined:undefined', details: JSON.stringify(result) }
  })
  await record('subprocess-denied', async () => {
    const result = await runGeneratedTool({ manifest, source: 'tool.output(typeof process + ":" + typeof require)', workspacePath, input: {} })
    return { passed: result.output === 'undefined:undefined', details: JSON.stringify(result) }
  })
  await record('env-denied', async () => {
    const result = await runGeneratedTool({ manifest, source: 'tool.output(typeof process + ":" + typeof Deno)', workspacePath, input: {} })
    return { passed: result.output === 'undefined:undefined', details: JSON.stringify(result) }
  })
  await record('timeout-cleanup', async () => {
    const timed = await runGeneratedTool({
      manifest: { ...manifest, limits: { ...manifest.limits, timeoutMs: 50 } },
      source: 'while (true) {}', workspacePath, input: {}
    })
    const followUp = await runGeneratedTool({ manifest, source: 'tool.output("alive")', workspacePath, input: {} })
    return { passed: timed.terminatedByBudget && followUp.output === 'alive', details: JSON.stringify({ timed, followUp }) }
  })
  await record('cancel-cleanup', async () => {
    const controller = new AbortController()
    const pending = runGeneratedTool({ manifest, source: 'while (true) {}', workspacePath, input: {}, signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    const cancelled = await pending
    const followUp = await runGeneratedTool({ manifest, source: 'tool.output("alive")', workspacePath, input: {} })
    return { passed: cancelled.terminatedByBudget && followUp.output === 'alive', details: JSON.stringify({ cancelled, followUp }) }
  })
  await record('ipc-registry-audit-isolation', async () => {
    const result = await runGeneratedTool({
      manifest,
      source: 'tool.output([typeof process, typeof require, typeof electron, typeof window, typeof global].join(":"))',
      workspacePath,
      input: {}
    })
    return { passed: result.output === 'undefined:undefined:undefined:undefined:undefined', details: JSON.stringify(result) }
  })
  await record('packaged-equivalence', async () => {
    const legit = await runGeneratedTool({ manifest, source, workspacePath, input: {} })
    const boundary = await runGeneratedTool({
      manifest,
      source: 'tool.output(tool.readFile("fixtures/undeclared.txt"))',
      workspacePath,
      input: {}
    })
    return {
      passed: legit.ok && legit.output === EXPECTED_OUTPUT
        && !boundary.ok && runtimeErrorCode(boundary.error) === 'generated-tool-filesystem-undeclared-file',
      details: JSON.stringify({ legit, boundary })
    }
  })

  const candidate = {
    candidate: 'quickjs-wasm' as const,
    env: 'packaged' as const,
    passesIsolation: cases.every((item) => item.status === 'pass'),
    cases
  }
  const report = {
    schemaVersion: 1,
    generatedAt: Date.now(),
    environment: 'packaged-windows',
    appVersion: app.getVersion(),
    resourcesPath: process.resourcesPath,
    runNonce: process.env['JOKER_PACKAGED_TOOL_RUN_NONCE'] ?? null,
    startedAt,
    finishedAt: Date.now(),
    runtime: manifest.runtime,
    expectedOutput: EXPECTED_OUTPUT,
    candidate,
    passed: candidate.passesIsolation
  }
  mkdirSync(dirname(outputReportPath), { recursive: true })
  writeFileSync(outputReportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  app.exit(report.passed ? 0 : 1)
  return true
}
