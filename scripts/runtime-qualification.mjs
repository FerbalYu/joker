// Fail-closed runtime qualification. Builds only when explicitly allowed and
// otherwise qualifies exact caller-provided package artifacts.
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runQualificationSuite } from './fixtures/runtime-qualification-suite.mjs'
import { runGeneratedTool } from '../src/main/generated-tools/runtime/runner.ts'
import { GeneratedToolManifestSchema, parseRuntimeQualificationReport } from '../src/shared/generated-tools-schema.ts'
import {
  deriveRuntimeLevel,
  qualificationCandidatePassesIsolation,
  runtimeQualificationFileIdentity,
  validateRuntimeQualificationReportEvidence,
  writeRuntimeQualificationReport
} from '../src/main/generated-tools/qualification.ts'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const fixtureRoot = join(root, 'scripts', 'fixtures', 'generated-tools', 'summarize-task-json')
const packagedQualificationScript = join(root, 'scripts', 'packaged-toolforge-qualification.mjs')
const PACKAGED_TIMEOUT_MS = 120_000
const BUILD_TIMEOUT_MS = 600_000
const EXPECTED_OUTPUT = 'open: 4\ndone: 3\nin_progress: 2'

function usage() {
  return `runtime-qualification.mjs
  --required-level L1|L2  minimum effective level; defaults to L2
  --no-build              never build; requires exact existing bundle/worker paths and packaged paths for L2
  --bundle <path>         exact out/main/index.js path
  --worker <path>         exact generated-tool-worker.js path
  --packaged-exe <path>   exact packaged executable to launch and bind
  --app-asar <path>       exact app.asar to bind
  --output <path>         exact runtime-qualification.json output path
  --skip-packaged         compatibility mode for explicit L1 qualification
  --clean                 delete the isolated run directory afterwards
  --help                  print this help`
}

function parseArgs(argv) {
  const flags = { requiredLevel: 'L2', noBuild: false, clean: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      const next = argv[++index]
      if (!next) throw new Error(`${arg} requires a value`)
      return resolve(next)
    }
    if (arg === '--required-level') {
      const level = argv[++index]
      if (level !== 'L1' && level !== 'L2') throw new Error('--required-level must be L1 or L2')
      flags.requiredLevel = level
    } else if (arg === '--no-build') flags.noBuild = true
    else if (arg === '--bundle') flags.bundle = value()
    else if (arg === '--worker') flags.worker = value()
    else if (arg === '--packaged-exe') flags.packagedExe = value()
    else if (arg === '--app-asar') flags.appAsar = value()
    else if (arg === '--output') flags.output = value()
    else if (arg === '--skip-packaged' || arg === '--skip-electron') flags.requiredLevel = 'L1'
    else if (arg === '--clean') flags.clean = true
    else if (arg === '--help' || arg === '-h') { console.log(usage()); process.exit(0) }
    else throw new Error(`unknown flag: ${arg}\n${usage()}`)
  }
  return flags
}

function sha256(path) { return createHash('sha256').update(readFileSync(path)).digest('hex') }
function isPathInside(parent, target) {
  const rel = relative(resolve(parent), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
function assertRegularFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} not found: ${path}`)
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file: ${path}`)
}
function evidenceIdentity(path, runDir) {
  assertRegularFile(path, 'qualification evidence')
  const rel = relative(resolve(runDir), resolve(path))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`evidence escaped qualification root: ${path}`)
  const stat = lstatSync(path)
  return { path: rel.split(sep).join('/'), size: stat.size, sha256: sha256(path) }
}
function normalizeEvidencePath(item, defaultDirectory) {
  if (item.evidence?.path) return item.evidence.path
  const legacy = item.evidencePath
  if (!legacy) throw new Error('passing case is missing evidence identity')
  const normalized = String(legacy).replaceAll('\\', '/')
  return normalized.includes('/') ? normalized : `${defaultDirectory}/${normalized}`
}
function normalizeCandidateEvidence(candidate, { runDir, defaultDirectory, strictEvidence }) {
  const cases = candidate.cases.map((item) => {
    if (item.status !== 'pass') {
      const { evidence: _evidence, evidencePath: _legacyEvidencePath, ...rest } = item
      return rest
    }
    try {
      const evidencePath = resolve(runDir, normalizeEvidencePath(item, defaultDirectory))
      if (!isPathInside(runDir, evidencePath)) throw new Error('evidence escaped qualification root')
      const parsed = JSON.parse(readFileSync(evidencePath, 'utf8'))
      if (parsed.id !== item.id && parsed.caseId !== item.id) throw new Error('evidence case id mismatch')
      const identity = evidenceIdentity(evidencePath, runDir)
      if (item.evidence && (item.evidence.size !== identity.size || item.evidence.sha256 !== identity.sha256)) {
        throw new Error('evidence size/hash mismatch')
      }
      return { id: item.id, status: item.status, details: item.details, evidence: identity }
    } catch (error) {
      if (strictEvidence) throw error
      return { id: item.id, status: 'inconclusive', details: `${item.details}; ${error instanceof Error ? error.message : String(error)}` }
    }
  })
  const normalized = { candidate: candidate.candidate, env: candidate.env, cases, ...(candidate.error ? { error: candidate.error } : {}) }
  return { ...normalized, passesIsolation: qualificationCandidatePassesIsolation(normalized, normalized.env) }
}

function spawnCommand(command, args, label) {
  const result = spawnSync(command, args, { cwd: root, env: process.env, windowsHide: true, stdio: 'inherit', timeout: BUILD_TIMEOUT_MS })
  if (result.error) throw new Error(`${label} failed: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${label} exited with code ${result.status}`)
}
function buildArtifacts(requiredLevel) {
  const electronVite = join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
  spawnCommand(process.execPath, [electronVite, 'build'], 'application build')
  if (requiredLevel !== 'L2') return
  const builder = join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js')
  spawnCommand(process.execPath, [builder, '--win', 'dir'], 'unpacked Windows package build')
}
function killProcessTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
  else { try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch {} } }
}
async function invokePackagedQualification(runDir, packagedExe) {
  const reportPath = join(runDir, 'packaged-toolforge-report.json')
  rmSync(reportPath, { force: true })
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [packagedQualificationScript], {
      cwd: root,
      env: { ...process.env, JOKER_PACKAGED_TOOL_REPORT_DIR: runDir, JOKER_PACKAGED_EXECUTABLE: packagedExe },
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    })
    let stderr = ''; child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    let settled = false
    const finish = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolvePromise({ reportPath, stderr, ...result }) } }
    const timer = setTimeout(() => { killProcessTree(child.pid); finish({ error: `packaged qualification timed out after ${PACKAGED_TIMEOUT_MS}ms` }) }, PACKAGED_TIMEOUT_MS)
    child.on('exit', (exitCode) => finish({ exitCode }))
    child.on('error', (error) => finish({ error: error.message }))
  })
}
function consumePackagedQualification(reportPath, runDir, packagedExe) {
  const raw = JSON.parse(readFileSync(reportPath, 'utf8'))
  if (raw.environment !== 'packaged-windows' || raw.runtime?.id !== 'quickjs-wasm') throw new Error('unexpected packaged qualification report identity')
  if (resolve(raw.artifact?.path ?? '') !== resolve(packagedExe)) throw new Error('packaged report qualified a different executable')
  assertRegularFile(packagedExe, 'packaged executable')
  const stat = lstatSync(packagedExe)
  if (raw.artifact?.size !== stat.size || raw.artifact?.sha256 !== sha256(packagedExe)) throw new Error('packaged executable changed during qualification')
  return {
    startedAt: raw.startedAt,
    finishedAt: raw.finishedAt,
    candidate: normalizeCandidateEvidence(raw.candidate, { runDir, defaultDirectory: 'evidence-packaged', strictEvidence: true })
  }
}

function makeCase(id, passed, details, evidence) { return { id, status: passed ? 'pass' : 'fail', details, evidence } }
async function runProductionQuickJsQualification({ runDir, workspace }) {
  const manifest = GeneratedToolManifestSchema.parse(JSON.parse(readFileSync(join(fixtureRoot, 'manifest.json'), 'utf8')))
  const source = readFileSync(join(fixtureRoot, manifest.entrypoint), 'utf8')
  const startedAt = Date.now(); const cases = []
  async function record(id, run) {
    const path = join(runDir, 'evidence-dev', `quickjs-wasm-${id}.json`)
    let result
    try { result = await run() } catch (error) { result = { passed: false, details: error instanceof Error ? error.message : String(error) } }
    writeFileSync(path, `${JSON.stringify({ id, ...result }, null, 2)}\n`, 'utf8')
    cases.push(makeCase(id, result.passed, result.details, evidenceIdentity(path, runDir)))
  }
  await record('legit-execution', async () => { const result = await runGeneratedTool({ manifest, source, workspacePath: workspace, input: {} }); return { passed: result.ok && result.output === EXPECTED_OUTPUT, details: JSON.stringify(result) } })
  await record('workspace-boundary', async () => {
    const attempts = await Promise.all(['fixtures/undeclared.txt', '../secret.txt'].map((path) => runGeneratedTool({ manifest, source: `tool.output(tool.readFile(${JSON.stringify(path)}))`, workspacePath: workspace, input: {} })))
    const hostProbe = await runGeneratedTool({ manifest, source: "let visible=false;try{visible=Boolean(({}).constructor.constructor('return process')())}catch{}tool.output(visible?'host-visible':'host-denied')", workspacePath: workspace, input: {} })
    return { passed: attempts.every((item) => !item.ok && item.error?.code === 'generated-tool-filesystem-undeclared-file') && hostProbe.output === 'host-denied', details: JSON.stringify({ attempts, hostProbe }) }
  })
  await record('network-denied', async () => { const result = await runGeneratedTool({ manifest, source: 'tool.output(typeof fetch + ":" + typeof WebSocket)', workspacePath: workspace, input: {} }); return { passed: result.output === 'undefined:undefined', details: JSON.stringify(result) } })
  await record('subprocess-denied', async () => { const result = await runGeneratedTool({ manifest, source: 'tool.output(typeof process + ":" + typeof require)', workspacePath: workspace, input: {} }); return { passed: result.output === 'undefined:undefined', details: JSON.stringify(result) } })
  await record('env-denied', async () => { const result = await runGeneratedTool({ manifest, source: 'tool.output(typeof process + ":" + typeof Deno)', workspacePath: workspace, input: {} }); return { passed: result.output === 'undefined:undefined', details: JSON.stringify(result) } })
  await record('timeout-cleanup', async () => { const timed = await runGeneratedTool({ manifest: { ...manifest, limits: { ...manifest.limits, timeoutMs: 50 } }, source: 'while(true){}', workspacePath: workspace, input: {} }); const followUp = await runGeneratedTool({ manifest, source: 'tool.output("alive")', workspacePath: workspace, input: {} }); return { passed: timed.terminatedByBudget && followUp.output === 'alive', details: JSON.stringify({ timed, followUp }) } })
  await record('cancel-cleanup', async () => { const controller = new AbortController(); const pending = runGeneratedTool({ manifest, source: 'while(true){}', workspacePath: workspace, input: {}, signal: controller.signal }); setTimeout(() => controller.abort(), 20); const cancelled = await pending; const followUp = await runGeneratedTool({ manifest, source: 'tool.output("alive")', workspacePath: workspace, input: {} }); return { passed: cancelled.terminatedByBudget && followUp.output === 'alive', details: JSON.stringify({ cancelled, followUp }) } })
  await record('ipc-registry-audit-isolation', async () => { const result = await runGeneratedTool({ manifest, source: 'tool.output([typeof process,typeof require,typeof electron,typeof window,typeof global].join(":"))', workspacePath: workspace, input: {} }); return { passed: result.output === 'undefined:undefined:undefined:undefined:undefined', details: JSON.stringify(result) } })
  const normalized = { candidate: 'quickjs-wasm', env: 'dev', cases }
  return { startedAt, finishedAt: Date.now(), candidate: { ...normalized, passesIsolation: qualificationCandidatePassesIsolation(normalized, 'dev') } }
}

function artifactIdentity(flags) {
  const bundle = flags.bundle ?? join(root, 'out', 'main', 'index.js')
  const worker = flags.worker ?? join(root, 'out', 'main', 'generated-tool-worker.js')
  const quickjs = join(root, 'node_modules', 'quickjs-emscripten', 'package.json')
  const lock = join(root, 'package-lock.json')
  for (const [path, label] of [[bundle, 'bundle'], [worker, 'worker'], [quickjs, 'QuickJS package'], [lock, 'package lock']]) assertRegularFile(path, label)
  const quickjsVersion = JSON.parse(readFileSync(quickjs, 'utf8')).version
  const identity = {
    bundle: runtimeQualificationFileIdentity(bundle, root), worker: runtimeQualificationFileIdentity(worker, root),
    quickjsPackage: { ...runtimeQualificationFileIdentity(quickjs, root), version: quickjsVersion },
    packageLock: runtimeQualificationFileIdentity(lock, root)
  }
  if (flags.requiredLevel === 'L2') {
    assertRegularFile(flags.packagedExe, 'packaged executable'); assertRegularFile(flags.appAsar, 'app.asar')
    identity.packaged = { executable: runtimeQualificationFileIdentity(flags.packagedExe, root), appAsar: runtimeQualificationFileIdentity(flags.appAsar, root) }
  }
  return identity
}

async function main() {
  const flags = parseArgs(process.argv.slice(2))
  if (flags.noBuild && (!flags.bundle || !flags.worker || (flags.requiredLevel === 'L2' && (!flags.packagedExe || !flags.appAsar)))) {
    throw new Error('--no-build requires --bundle and --worker, plus --packaged-exe and --app-asar for L2')
  }
  if (!flags.noBuild) buildArtifacts(flags.requiredLevel)
  flags.bundle ??= join(root, 'out', 'main', 'index.js'); flags.worker ??= join(root, 'out', 'main', 'generated-tool-worker.js')
  if (flags.requiredLevel === 'L2') {
    flags.packagedExe ??= join(root, 'dist', 'win-unpacked', 'JOKER.exe')
    flags.appAsar ??= join(dirname(flags.packagedExe), 'resources', 'app.asar')
  }
  const outputPath = flags.output ?? join(process.env.JOKER_RUNTIME_QUALIFICATION_DIR ? resolve(process.env.JOKER_RUNTIME_QUALIFICATION_DIR) : mkdtempSync(join(tmpdir(), 'joker-runtime-qualification-')), '.joker', 'qualification', 'runtime-qualification.json')
  const runDir = dirname(outputPath); const home = resolve(runDir, '..', '..')
  if (!isPathInside(home, outputPath)) throw new Error('qualification output must remain under its isolated home')
  rmSync(runDir, { recursive: true, force: true }); mkdirSync(join(runDir, 'workspace', 'fixtures'), { recursive: true }); mkdirSync(join(runDir, 'evidence-dev'), { recursive: true })
  const workspace = join(runDir, 'workspace')
  writeFileSync(join(workspace, 'fixtures', 'tasks.json'), readFileSync(join(root, 'scripts', 'fixtures', 'generated-tools', 'tasks.json')), 'utf8')
  writeFileSync(join(runDir, 'secret.txt'), 'TOP-SECRET-CANARY-OUTSIDE-WORKSPACE', 'utf8')
  const [control, production] = await Promise.all([
    runQualificationSuite({ env: 'dev', runDir, workspacePath: workspace, evidenceDir: join(runDir, 'evidence-dev'), candidateIds: ['node-vm', 'child-process'] }),
    runProductionQuickJsQualification({ runDir, workspace })
  ])
  const devCandidates = [production.candidate, ...control.candidates.map((candidate) => normalizeCandidateEvidence(candidate, { runDir, defaultDirectory: 'evidence-dev', strictEvidence: false }))]
  const mandatoryCandidate = devCandidates.find((candidate) => candidate.candidate === 'quickjs-wasm')
  const devPassed = Boolean(mandatoryCandidate?.passesIsolation) && !devCandidates.some((candidate) => candidate.error)
  let packaged
  if (flags.requiredLevel === 'L2') {
    const invocation = await invokePackagedQualification(runDir, flags.packagedExe)
    if (invocation.error || invocation.exitCode !== 0 || !existsSync(invocation.reportPath)) throw new Error(invocation.error ?? `packaged qualification failed (${invocation.exitCode}): ${invocation.stderr}`)
    packaged = consumePackagedQualification(invocation.reportPath, runDir, flags.packagedExe)
  }
  const reportInput = {
    schemaVersion: 2, generatedAt: Date.now(), level: 'L0', artifactIdentity: artifactIdentity(flags),
    environments: {
      dev: { environment: 'dev', status: devPassed ? 'passed' : 'failed', startedAt: Math.min(control.startedAt, production.startedAt), finishedAt: Math.max(control.finishedAt, production.finishedAt), ...(devPassed ? {} : { error: 'mandatory QuickJS candidate or candidate harness failed' }) },
      packaged: packaged ? { environment: 'packaged', status: packaged.candidate.passesIsolation ? 'passed' : 'failed', startedAt: packaged.startedAt, finishedAt: packaged.finishedAt, ...(packaged.candidate.passesIsolation ? {} : { error: 'packaged mandatory isolation failed' }) } : { environment: 'packaged', status: 'incomplete', startedAt: Date.now(), finishedAt: Date.now(), error: 'L1 qualification did not request a packaged artifact' }
    },
    candidates: [...devCandidates, ...(packaged ? [packaged.candidate] : [])],
    limitations: ['Qualification is bound to exact bundle, worker, QuickJS package, lockfile, and when L2, packaged executable and app.asar identities.']
  }
  const parsed = parseRuntimeQualificationReport({ ...reportInput, level: deriveRuntimeLevel(reportInput) })
  const report = validateRuntimeQualificationReportEvidence(parsed, outputPath)
  const persisted = writeRuntimeQualificationReport(report, home)
  if (resolve(persisted) !== resolve(outputPath)) throw new Error(`output path must equal ${persisted}`)
  const rank = { L0: 0, L1: 1, L2: 2 }
  const failed = !devPassed || (flags.requiredLevel === 'L2' && !packaged?.candidate.passesIsolation) || rank[report.level] < rank[flags.requiredLevel]
  console.log(JSON.stringify({ reportPath: persisted, level: report.level, requiredLevel: flags.requiredLevel, passed: !failed }))
  if (flags.clean) rmSync(home, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
}
main().catch((error) => { console.error(`runtime qualification failed: ${error instanceof Error ? error.message : String(error)}`); process.exit(1) })
