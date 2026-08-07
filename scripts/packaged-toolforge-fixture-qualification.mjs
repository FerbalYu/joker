import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const executable = resolve(process.env.JOKER_PACKAGED_EXECUTABLE ?? join(root, 'dist', 'win-unpacked', 'JOKER.exe'))
const fixtureRoot = resolve(process.env.JOKER_PACKAGED_FIXTURE_ROOT ?? join(executable, '..', 'resources', 'toolforge-fixture'))
const qualificationHome = process.env.JOKER_PACKAGED_TOOLFORGE_FIXTURE_QUALIFICATION_HOME
  ? resolve(process.env.JOKER_PACKAGED_TOOLFORGE_FIXTURE_QUALIFICATION_HOME)
  : null
const runDir = process.env.JOKER_TOOLFORGE_FIXTURE_REPORT_DIR
  ? resolve(process.env.JOKER_TOOLFORGE_FIXTURE_REPORT_DIR)
  : mkdtempSync(join(tmpdir(), 'joker-toolforge-fixture-'))
const home = join(runDir, 'home')
const workspace = join(runDir, 'workspace')
const reportPath = join(runDir, 'toolforge-fixture-report.json')

rmSync(runDir, { recursive: true, force: true })
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
if (!existsSync(join(fixtureRoot, 'manifest.json'))) {
  console.error(`packaged fixture resource not found: ${fixtureRoot}`)
  process.exit(1)
}

function killTree(pid) {
  if (!pid) return
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* already exited */ }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function launch(label) {
  const runId = `${label}-${randomUUID()}`
  const childReportPath = join(runDir, `${label}-report.json`)
  const child = spawn(executable, [], {
    cwd: root,
    env: {
      ...process.env,
      JOKER_HOME: home,
      JOKER_PACKAGED_TOOLFORGE_FIXTURE_QUALIFICATION: '1',
      JOKER_PACKAGED_TOOLFORGE_FIXTURE_WORKSPACE: workspace,
      JOKER_PACKAGED_TOOLFORGE_FIXTURE_ROOT: fixtureRoot,
      JOKER_PACKAGED_TOOLFORGE_FIXTURE_REPORT: childReportPath,
      JOKER_PACKAGED_TOOLFORGE_FIXTURE_RUN_ID: runId,
      ...(qualificationHome
        ? { JOKER_PACKAGED_TOOLFORGE_FIXTURE_QUALIFICATION_HOME: qualificationHome }
        : {}),
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
  while (!existsSync(childReportPath) && child.exitCode === null && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 200))
  }
  killTree(child.pid)
  if (!existsSync(childReportPath)) throw new Error(`${label} did not produce a report\n${stderr}\n${stdout}`)
  const childReport = JSON.parse(readFileSync(childReportPath, 'utf8'))
  const registryPath = join(home, '.joker', 'generated-tools', 'registry.json')
  const registryText = readFileSync(registryPath, 'utf8')
  const versionPath = join(home, '.joker', 'generated-tools', 'tools', 'summarize-task-json', 'versions', 'v1', 'version.json')
  const report = {
    label,
    ...childReport,
    registryHash: sha256(registryText),
    versionHash: sha256(readFileSync(versionPath)),
    stderr,
    stdout
  }
  if (report.status !== 'pass' || report.output !== 'open: 4\ndone: 3\nin_progress: 2'
    || report.registryRevision !== 2 || report.capabilityRevision !== 1
    || report.invocation?.status !== 'finished' || report.invocation?.outcome !== 'succeeded') {
    throw new Error(`${label} produced an invalid fixture call: ${JSON.stringify(report)}`)
  }
  return report
}

try {
  const first = await launch('first-start')
  const second = await launch('restart')
  const passed = first.registryHash === second.registryHash
    && first.versionHash === second.versionHash
    && first.invocationCount === 1
    && second.invocationCount === 2
    && first.invocation.id !== second.invocation.id
  const report = { schemaVersion: 1, runId: randomUUID(), status: passed ? 'pass' : 'fail', first, second, runDir }
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ reportPath, passed, runDir }))
  process.exit(passed ? 0 : 1)
} catch (error) {
  const report = { schemaVersion: 1, runId: randomUUID(), status: 'fail', error: error instanceof Error ? error.message : String(error), runDir }
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.error(JSON.stringify({ reportPath, passed: false, runDir }))
  process.exit(1)
}
