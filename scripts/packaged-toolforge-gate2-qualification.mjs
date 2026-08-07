import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const executable = resolve(process.env.JOKER_PACKAGED_EXECUTABLE ?? join(root, 'dist', 'win-unpacked', 'JOKER.exe'))
const runDir = process.env.JOKER_PACKAGED_GATE2_REPORT_DIR
  ? resolve(process.env.JOKER_PACKAGED_GATE2_REPORT_DIR)
  : mkdtempSync(join(tmpdir(), 'joker-packaged-gate2-'))
const home = join(runDir, 'home')
const reportPath = join(runDir, 'packaged-gate2-report.json')
const failurePath = join(runDir, 'packaged-gate2-failure.json')
const runNonce = randomUUID()
rmSync(reportPath, { force: true })
rmSync(failurePath, { force: true })
mkdirSync(home, { recursive: true })

const qualificationHome = process.env.JOKER_PACKAGED_GATE2_QUALIFICATION_HOME
const qualificationReport = qualificationHome
  ? join(qualificationHome, '.joker', 'qualification', 'runtime-qualification.json')
  : null
if (!qualificationReport || !existsSync(qualificationReport)) {
  console.error('JOKER_PACKAGED_GATE2_QUALIFICATION_HOME must contain an L2 runtime qualification report')
  process.exit(1)
}
const qualification = JSON.parse(readFileSync(qualificationReport, 'utf8'))
if (qualification.level !== 'L2') {
  console.error('JOKER_PACKAGED_GATE2_QUALIFICATION_HOME is not qualified at L2')
  process.exit(1)
}

if (!existsSync(executable)) {
  console.error(`packaged executable not found: ${executable}`)
  process.exit(1)
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function killTree(pid) {
  if (!pid) return
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* already exited */ }
}

const env = {
  JOKER_HOME: home,
  JOKER_PACKAGED_GATE2_QUALIFICATION: '1',
  JOKER_PACKAGED_GATE2_REPORT: reportPath,
  JOKER_PACKAGED_GATE2_RUN_NONCE: runNonce,
  JOKER_PACKAGED_GATE2_QUALIFICATION_HOME: qualificationHome,
  ELECTRON_ENABLE_LOGGING: '1',
  PATH: process.env.PATH ?? '',
  SystemRoot: process.env.SystemRoot ?? '',
  TEMP: process.env.TEMP ?? '',
  TMP: process.env.TMP ?? ''
}
const child = spawn(executable, [], {
  cwd: root,
  env,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe']
})
let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk) => { stdout += String(chunk) })
child.stderr.on('data', (chunk) => { stderr += String(chunk) })

const deadline = Date.now() + 120_000
while (!existsSync(reportPath) && child.exitCode === null && Date.now() < deadline) {
  await new Promise((resolveWait) => setTimeout(resolveWait, 250))
}
killTree(child.pid)

if (!existsSync(reportPath)) {
  writeFileSync(failurePath, `${JSON.stringify({ executable, stdout, stderr, exitCode: child.exitCode }, null, 2)}\n`, 'utf8')
  console.error(`packaged Gate 2 qualification did not produce a report: ${failurePath}`)
  process.exit(1)
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const expectedScenarios = ['success', 'explicit-failure', 'fake-success', 'overreach']
const reportShapeValid = report.schemaVersion === 1
  && report.qualification === 'toolforge-gate2-packaged'
  && report.environment === 'packaged-windows'
  && report.runNonce === runNonce
  && report.passed === true
  && report.toolId === 'gate2-qualification-tool'
  && Array.isArray(report.scenarios)
  && report.scenarios.length === expectedScenarios.length
  && expectedScenarios.every((scenario) => report.scenarios.some((item) => item.scenario === scenario && item.pass === true))
  && report.scenarios.every((item) => item.trusted === false && item.registered === false && item.active === false
    && item.originalTaskComplete === false && item.capabilityRevisionBefore === item.capabilityRevisionAfter)
const envelope = {
  ...report,
  artifact: { path: executable, size: statSync(executable).size, sha256: sha256(executable) },
  reportShapeValid,
  runDir
}
writeFileSync(reportPath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ reportPath, passed: reportShapeValid, runDir }))
process.exit(reportShapeValid ? 0 : 1)
