import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const executable = resolve(process.env.JOKER_PACKAGED_EXECUTABLE ?? join(root, 'dist', 'win-unpacked', 'JOKER.exe'))
const runDir = process.env.JOKER_PACKAGED_TOOL_REPORT_DIR
  ? resolve(process.env.JOKER_PACKAGED_TOOL_REPORT_DIR)
  : mkdtempSync(join(tmpdir(), 'joker-packaged-toolforge-'))
const workspace = join(runDir, 'workspace')
const home = join(runDir, 'home')
const reportPath = join(runDir, 'packaged-toolforge-report.json')
const runNonce = randomUUID()
const failurePath = join(runDir, 'packaged-toolforge-failure.json')
const evidenceDir = join(runDir, 'evidence-packaged')
rmSync(reportPath, { force: true })
rmSync(failurePath, { force: true })
rmSync(evidenceDir, { recursive: true, force: true })
mkdirSync(join(workspace, 'fixtures'), { recursive: true })
writeFileSync(
  join(workspace, 'fixtures', 'tasks.json'),
  readFileSync(join(root, 'scripts', 'fixtures', 'generated-tools', 'tasks.json'), 'utf8'),
  'utf8'
)

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

const child = spawn(executable, [], {
  cwd: root,
  env: {
    ...process.env,
    JOKER_HOME: home,
    JOKER_PACKAGED_TOOL_QUALIFICATION: '1',
    JOKER_PACKAGED_TOOL_REPORT: reportPath,
    JOKER_PACKAGED_TOOL_RUN_NONCE: runNonce,
    JOKER_PACKAGED_TOOL_WORKSPACE: workspace,
    ELECTRON_ENABLE_LOGGING: '1'
  },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe']
})
let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk) => { stdout += String(chunk) })
child.stderr.on('data', (chunk) => { stderr += String(chunk) })

const deadline = Date.now() + 60_000
while (!existsSync(reportPath) && child.exitCode === null && Date.now() < deadline) {
  await new Promise((resolveWait) => setTimeout(resolveWait, 250))
}
killTree(child.pid)

if (!existsSync(reportPath)) {
  writeFileSync(failurePath, `${JSON.stringify({ executable, stdout, stderr, exitCode: child.exitCode }, null, 2)}\n`, 'utf8')
  console.error(`packaged qualification did not produce a report: ${failurePath}`)
  process.exit(1)
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const evidence = existsSync(evidenceDir)
  ? Object.fromEntries(
      readdirSync(evidenceDir)
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => [`evidence-packaged/${name}`, sha256(join(evidenceDir, name))])
    )
  : {}
const expectedEvidence = (report.candidate?.cases ?? []).map((item) => item.evidence?.path ?? item.evidencePath)
const reportShapeValid = report.schemaVersion === 1
  && report.environment === 'packaged-windows'
  && report.runNonce === runNonce
  && report.passed === true
  && report.candidate?.candidate === 'quickjs-wasm'
  && report.candidate?.env === 'packaged'
  && report.candidate?.passesIsolation === true
  && Array.isArray(report.candidate?.cases)
  && report.candidate.cases.length === 9
  && report.candidate.cases.every((item) => item?.status === 'pass')
const evidenceComplete = expectedEvidence.length > 0
  && expectedEvidence.every((path) => typeof path === 'string' && typeof evidence[path] === 'string')
const envelope = {
  ...report,
  artifact: { path: executable, size: statSync(executable).size, sha256: sha256(executable) },
  evidence,
  evidenceComplete,
  reportShapeValid,
  runDir
}
writeFileSync(reportPath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8')
const passed = reportShapeValid && evidenceComplete
console.log(JSON.stringify({ reportPath, passed, runDir }))
process.exit(passed ? 0 : 1)
