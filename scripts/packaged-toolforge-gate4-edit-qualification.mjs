import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const executable = resolve(process.env.JOKER_PACKAGED_EXECUTABLE ?? join(root, 'dist', 'win-unpacked', 'JOKER.exe'))
const fixtureRoot = join(root, 'dist', 'win-unpacked', 'resources', 'toolforge-fixture')
const qualificationHome = process.env.JOKER_PACKAGED_GATE4_QUALIFICATION_HOME
  ? resolve(process.env.JOKER_PACKAGED_GATE4_QUALIFICATION_HOME)
  : resolve(root, '.qa', 'runtime-qualification-current')
const qualificationReport = join(qualificationHome, '.joker', 'qualification', 'runtime-qualification.json')
const runDir = process.env.JOKER_PACKAGED_GATE4_REPORT_DIR
  ? resolve(process.env.JOKER_PACKAGED_GATE4_REPORT_DIR)
  : mkdtempSync(join(tmpdir(), 'joker-packaged-gate4-edit-'))
const home = join(runDir, 'home')
const workspace = join(runDir, 'workspace')
const reportPath = join(runDir, 'packaged-gate4-edit-report.json')
const failurePath = join(runDir, 'packaged-gate4-edit-failure.json')
const runNonce = randomUUID()

rmSync(reportPath, { force: true })
rmSync(failurePath, { force: true })
mkdirSync(join(workspace, 'fixtures'), { recursive: true })
writeFileSync(join(workspace, 'fixtures', 'tasks.json'), readFileSync(join(root, 'scripts', 'fixtures', 'generated-tools', 'tasks.json'), 'utf8'), 'utf8')

if (!existsSync(executable)) {
  console.error(`packaged executable not found: ${executable}`)
  process.exit(1)
}
if (!existsSync(join(fixtureRoot, 'manifest.json'))) {
  console.error(`packaged ToolForge fixture not found: ${fixtureRoot}`)
  process.exit(1)
}
if (!existsSync(qualificationReport)) {
  console.error(`L2 runtime qualification report not found: ${qualificationReport}`)
  process.exit(1)
}
const qualification = JSON.parse(readFileSync(qualificationReport, 'utf8'))
if (qualification.level !== 'L2') {
  console.error('Packaged Gate 4 qualification requires an L2 runtime qualification report')
  process.exit(1)
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function killTree(pid) {
  if (!pid) return
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* already exited */ }
}

const child = spawn(executable, [], {
  cwd: root,
  env: {
    JOKER_HOME: home,
    JOKER_PACKAGED_GATE4_EDIT_QUALIFICATION: '1',
    JOKER_PACKAGED_GATE4_EDIT_REPORT: reportPath,
    JOKER_PACKAGED_GATE4_EDIT_RUN_NONCE: runNonce,
    JOKER_PACKAGED_GATE4_EDIT_WORKSPACE: workspace,
    JOKER_PACKAGED_GATE4_EDIT_FIXTURE_ROOT: fixtureRoot,
    JOKER_PACKAGED_GATE4_QUALIFICATION_HOME: qualificationHome,
    ELECTRON_ENABLE_LOGGING: '1',
    PATH: process.env.PATH ?? '',
    SystemRoot: process.env.SystemRoot ?? '',
    TEMP: process.env.TEMP ?? '',
    TMP: process.env.TMP ?? ''
  },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe']
})
let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk) => { stdout += String(chunk) })
child.stderr.on('data', (chunk) => { stderr += String(chunk) })

const deadline = Date.now() + 180_000
while (!existsSync(reportPath) && child.exitCode === null && Date.now() < deadline) {
  await new Promise((resolveWait) => setTimeout(resolveWait, 250))
}
killTree(child.pid)

if (!existsSync(reportPath)) {
  writeFileSync(failurePath, `${JSON.stringify({ executable, stdout, stderr, exitCode: child.exitCode }, null, 2)}\n`, 'utf8')
  console.error(`packaged Gate 4 edit qualification did not produce a report: ${failurePath}`)
  process.exit(1)
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const scenarios = Array.isArray(report.scenarios) ? report.scenarios : []
const success = scenarios.find((item) => item.scenario === 'success')
const failure = scenarios.find((item) => item.scenario === 'failure')
const reportShapeValid = report.schemaVersion === 1
  && report.qualification === 'toolforge-gate4-edit-packaged'
  && report.environment === 'packaged-windows'
  && report.runNonce === runNonce
  && report.passed === true
  && scenarios.length === 2
  && success?.pass === true
  && success?.promoted === true
  && success?.editDiffRecorded === true
  && success?.capabilityRevision === 2
  && success?.versionCount === 2
  && success?.baseFingerprintPreserved === true
  && success?.invocationOutcome === 'succeeded'
  && failure?.pass === true
  && failure?.jobStatus === 'failed'
  && failure?.activeVersionId === 'v1'
  && failure?.lastStableVersionId === 'v1'
  && failure?.capabilityRevision === 1
  && failure?.versionCount === 1
  && failure?.baseFingerprintPreserved === true
  && failure?.invocationOutcome === 'succeeded'
const envelope = {
  ...report,
  artifact: { path: executable, size: statSync(executable).size, sha256: sha256(executable) },
  qualificationReport: { path: qualificationReport, sha256: sha256(qualificationReport) },
  reportShapeValid,
  runDir,
  stdout,
  stderr
}
writeFileSync(reportPath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8')
if (reportShapeValid && process.env.JOKER_PACKAGED_GATE4_RETAIN_DIR) {
  const retainDir = resolve(process.env.JOKER_PACKAGED_GATE4_RETAIN_DIR)
  rmSync(retainDir, { recursive: true, force: true })
  mkdirSync(retainDir, { recursive: true })
  cpSync(reportPath, join(retainDir, 'packaged-gate4-edit-report.json'))
}
console.log(JSON.stringify({ reportPath, passed: reportShapeValid, runDir }))
process.exit(reportShapeValid ? 0 : 1)
