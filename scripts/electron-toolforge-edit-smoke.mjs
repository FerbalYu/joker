import { createHash } from 'node:crypto'
import { chromium } from 'playwright-core'
import { execFileSync, spawn } from 'node:child_process'
import { cp, lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { once } from 'node:events'

const expectFailure = process.argv.includes('--failure')
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const runDir = await mkdtemp(join(tmpdir(), 'joker-electron-toolforge-edit-'))
const home = join(runDir, 'home')
const userData = join(runDir, 'electron-user-data')
const workspace = join(runDir, 'workspace')
const logPath = join(runDir, 'fake-provider.log')
const reportPath = join(runDir, 'report.json')
const retainDirArg = process.argv.find((argument) => argument.startsWith('--retain-dir='))
const retainDir = retainDirArg ? resolve(root, retainDirArg.slice('--retain-dir='.length)) : null
const providerPort = 20700 + Math.floor(Math.random() * 400)
const checks = []
let provider
let electron
let browser
let output = ''
let failure = null

function check(name, pass, details) {
  const item = { name, pass: Boolean(pass), ...(details === undefined ? {} : { details }) }
  checks.push(item)
  if (!item.pass) throw new Error(`${name}: ${JSON.stringify(details ?? pass)}`)
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
    } catch (error) {
      lastError = error
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error(`${label} timed out${lastError instanceof Error ? `: ${lastError.message}` : ''}`)
}

async function stop(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* best effort */ }
  } else {
    child.kill('SIGTERM')
    await Promise.race([once(child, 'exit'), new Promise((resolveWait) => setTimeout(resolveWait, 5000))])
  }
}

async function waitForProvider() {
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('fake provider did not start')), 20_000)
    const onData = (chunk) => {
      if (String(chunk).includes('FAKE_PROVIDER_READY')) {
        clearTimeout(timer)
        resolveReady()
      }
    }
    provider.stdout.on('data', onData)
    provider.stderr.on('data', onData)
    provider.once('error', reject)
  })
}

async function launch() {
  electron = spawn(join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron'), [
    `--remote-debugging-port=${21000 + Math.floor(Math.random() * 400)}`,
    `--user-data-dir=${userData}`,
    resolve(root, 'out/main/index.js')
  ], {
    cwd: root,
    env: {
      ...process.env,
      JOKER_HOME: home,
      JOKER_INSTALL_TOOLFORGE_FIXTURE: '1',
      ELECTRON_ENABLE_LOGGING: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  const endpoint = await new Promise((resolveEndpoint, reject) => {
    const find = () => {
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (match) resolveEndpoint(match[1])
    }
    const onData = (chunk) => { output += String(chunk); find() }
    electron.stdout.on('data', onData)
    electron.stderr.on('data', onData)
    electron.once('error', reject)
    electron.once('exit', (code) => reject(new Error(`electron exited before CDP: ${code}`)))
    setTimeout(() => reject(new Error(`electron CDP timeout: ${output}`)), 20_000)
  })
  browser = await chromium.connectOverCDP(endpoint, { timeout: 60_000 })
  const context = browser.contexts()[0]
  await waitFor(() => context.pages().length > 0, 20_000, 'renderer page')
  const page = context.pages()[0]
  if (!page) throw new Error('renderer page missing')
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.joker?.generatedTools?.get))
  await waitFor(async () => (await page.evaluate(() => window.joker.session.list())).length > 0, 20_000, 'initial session')
  return page
}

const qualificationCases = [
  'legit-execution',
  'workspace-boundary',
  'network-denied',
  'subprocess-denied',
  'env-denied',
  'timeout-cleanup',
  'cancel-cleanup',
  'ipc-registry-audit-isolation'
]

async function fileIdentity(rootDir, relativePath, contents) {
  const path = join(rootDir, ...relativePath.split('/'))
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents)
  const stat = await lstat(path)
  return {
    path: relativePath,
    size: stat.size,
    sha256: createHash('sha256').update(await readFile(path)).digest('hex')
  }
}

async function installQualification() {
  const qualificationRoot = join(home, '.joker', 'qualification')
  await mkdir(qualificationRoot, { recursive: true })
  const candidates = []
  for (const env of ['dev', 'packaged']) {
    const ids = env === 'packaged' ? [...qualificationCases, 'packaged-equivalence'] : qualificationCases
    const cases = []
    for (const id of ids) {
      const evidence = await fileIdentity(
        qualificationRoot,
        `evidence/${env}-${id}.json`,
        `${JSON.stringify({ id })}\n`
      )
      cases.push({ id, status: 'pass', details: `${env} ${id} passed`, evidence })
    }
    candidates.push({ candidate: 'quickjs-wasm', env, passesIsolation: true, cases })
  }
  const quickjsPackage = JSON.parse(
    await readFile(join(root, 'node_modules', 'quickjs-emscripten', 'package.json'), 'utf8')
  )
  const artifactIdentity = {
    bundle: await fileIdentity(qualificationRoot, 'artifacts/out/main/index.js', 'fixture-bundle'),
    worker: await fileIdentity(
      qualificationRoot,
      'artifacts/out/main/generated-tool-worker.js',
      'fixture-worker'
    ),
    quickjsPackage: {
      ...await fileIdentity(
        qualificationRoot,
        'artifacts/node_modules/quickjs-emscripten/package.json',
        `${JSON.stringify({ version: quickjsPackage.version })}\n`
      ),
      version: quickjsPackage.version
    },
    packageLock: await fileIdentity(
      qualificationRoot,
      'artifacts/package-lock.json',
      'fixture-lock'
    ),
    packaged: {
      executable: await fileIdentity(
        qualificationRoot,
        'artifacts/dist/win-unpacked/JOKER.exe',
        'fixture-executable'
      ),
      appAsar: await fileIdentity(
        qualificationRoot,
        'artifacts/dist/win-unpacked/resources/app.asar',
        'fixture-asar'
      )
    }
  }
  await writeFile(join(qualificationRoot, 'runtime-qualification.json'), `${JSON.stringify({
    schemaVersion: 2,
    generatedAt: Date.now(),
    level: 'L2',
    artifactIdentity,
    environments: {
      dev: { environment: 'dev', status: 'passed', startedAt: 1, finishedAt: 2 },
      packaged: { environment: 'packaged', status: 'passed', startedAt: 1, finishedAt: 2 }
    },
    candidates,
    limitations: []
  }, null, 2)}\n`)
}

try {
  await mkdir(join(workspace, 'fixtures'), { recursive: true })
  await writeFile(join(workspace, 'fixtures', 'tasks.json'), await readFile(join(root, 'scripts/fixtures/generated-tools/tasks.json'), 'utf8'))
  await mkdir(join(home, '.joker'), { recursive: true })
  await installQualification()
  await writeFile(join(home, '.joker', 'config.json'), JSON.stringify({ providers: [{ id: 'qa-provider', name: 'QA Provider', type: 'openai-compatible', apiFormat: 'chat-completions', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'qa-key', models: [{ id: 'gpt-4o', name: 'gpt-4o', enabled: true }], currentModelId: 'gpt-4o', enabled: true }], activeProviderId: 'qa-provider', mcpServers: [], skills: [], approvalMode: 'full-auto' }, null, 2))
  await writeFile(join(home, '.joker', 'projects.json'), JSON.stringify({ projects: [{ id: 'qualification-p0', name: 'ToolForge Edit Qualification', path: workspace, lastUsedAt: Date.now() }], activeProjectId: 'qualification-p0' }, null, 2))
  provider = spawn(process.execPath, [join(root, 'scripts/fixtures/fake-provider.mjs')], { cwd: root, env: { ...process.env, PORT: String(providerPort), LOG_PATH: logPath, JOKER_FAKE_SCENARIO: expectFailure ? 'toolforge-edit-failure' : 'toolforge-edit-success' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  await waitForProvider()
  const page = await launch()
  const binding = await page.evaluate(async () => {
    const projects = await window.joker.project.get()
    const sessions = await window.joker.session.list()
    const projectId = projects.state?.activeProjectId
    const sessionId = sessions[0]?.id
    return {
      projectId,
      sessionId,
      saved: Boolean(projectId && sessionId && await window.joker.session.setProject(sessionId, projectId))
    }
  })
  check('Electron edit session is bound to the qualification workspace', binding.saved && binding.projectId === 'qualification-p0', binding)
  const initial = await page.evaluate(() => window.joker.generatedTools.get('summarize-task-json'))
  check('fixture v1 is available', initial.success && initial.data.summary.activeVersionId === 'v1', initial)
  if (!initial.success) throw new Error('fixture unavailable')
  const v1 = initial.data.versions.find((version) => version.id === 'v1')
  check('v1 fingerprint is present', Boolean(v1?.fingerprint))
  const edit = await page.evaluate(({ fingerprint }) => window.joker.generatedTools.edit({ toolId: 'summarize-task-json', baseVersionId: 'v1', baseFingerprint: fingerprint, instruction: 'Preserve behavior and improve the implementation.', requestedFrom: 'settings' }), { fingerprint: v1.fingerprint })
  check('natural-language-edit request is executed for the selected Generated Tool', edit.success && edit.data.originalTaskComplete === false, edit)
  check('real Electron edit IPC creates a job', edit.success && edit.data.originalTaskComplete === false, edit)
  let detail = initial.data
  for (let i = 0; i < 120; i += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
    const next = await page.evaluate(() => window.joker.generatedTools.get('summarize-task-json'))
    if (next.success) {
      detail = next.data
      const job = detail.recentJobs.find((item) => item.id === edit.data.jobId)
      if (job && ['awaiting-policy', 'failed'].includes(job.status)) break
    }
  }
  const job = detail.recentJobs.find((item) => item.id === edit.data.jobId)
  check('edit job binds immutable base', job?.mode === 'edit' && job.baseVersionId === 'v1' && job.baseFingerprint === v1.fingerprint, job)
  check('v1 remains active before promotion', detail.summary.activeVersionId === 'v1', detail.summary)
  const providerLog = await readFile(logPath, 'utf8')
  check('ForgeAgent edit calls are present', /ForgeReadSpec/.test(providerLog) && /ForgeWriteFile/.test(providerLog) && /ForgeRunCheck/.test(providerLog) && /ForgeSubmitCandidate/.test(providerLog))

  if (expectFailure) {
    check('invalid edit fails host validation', job?.status === 'failed' && /validation|expected|output|candidate/i.test(job.error ?? ''), job)
    const afterFailure = await page.evaluate(() => window.joker.generatedTools.get('summarize-task-json'))
    check('failed edit preserves v1 active and last-stable pointers', afterFailure.success && afterFailure.data.summary.activeVersionId === 'v1' && afterFailure.data.summary.lastStableVersionId === 'v1', afterFailure)
    check('failed edit does not publish a version or increment capability revision', afterFailure.success && afterFailure.data.versions.length === 1 && afterFailure.data.capabilityRevision === 1, afterFailure)
    check('failed edit preserves immutable v1 fingerprint', afterFailure.success && afterFailure.data.versions.some((version) => version.id === 'v1' && version.fingerprint === v1.fingerprint && version.active && version.stable), afterFailure)

    const textarea = page.locator('textarea').first()
    await waitFor(async () => await textarea.isVisible() && await textarea.isEnabled(), 20_000, 'chat input readiness')
    await textarea.fill('Use the summarize-task-json Generated Tool and report its exact output.')
    const providerRequestMarker = 'Use the summarize-task-json Generated Tool and report its exact output.'
    await waitFor(async () => {
      if ((await readFile(logPath, 'utf8')).includes(providerRequestMarker)) return true
      const sendButton = page.getByRole('button', { name: /发送|Send/ })
      if (await sendButton.isEnabled()) {
        if (!(await textarea.inputValue()).trim()) await textarea.fill(providerRequestMarker)
        await sendButton.click()
      }
      return false
    }, 60_000, 'stable Generated Tool provider request')
    await waitFor(async () => {
      const state = await page.evaluate(() => window.joker.generatedTools.get('summarize-task-json'))
      return state.success && state.data.recentInvocations.some((invocation) => invocation.versionId === 'v1' && invocation.status === 'finished' && invocation.outcome === 'succeeded')
    }, 60_000, 'v1 invocation completion')
    const afterExecution = await page.evaluate(() => window.joker.generatedTools.get('summarize-task-json'))
    check('v1 remains executable after failed edit', afterExecution.success && afterExecution.data.recentInvocations.some((invocation) => invocation.versionId === 'v1' && invocation.status === 'finished' && invocation.outcome === 'succeeded'), afterExecution)
  } else {
    check('edit reaches awaiting policy', job?.status === 'awaiting-policy', job)
    const promoted = await page.evaluate(
      ({ jobId, jobRevision, registryRevision, fingerprint }) => window.joker.generatedTools.promote({
        jobId,
        expectedJobRevision: jobRevision,
        registryRevision,
        expectedCandidateFingerprint: fingerprint
      }),
      {
        jobId: job.id,
        jobRevision: job.jobRevision,
        registryRevision: detail.registryRevision,
        fingerprint: job.candidateFingerprint
      }
    )
    check('real Electron promotion succeeds', promoted.success && promoted.data.action === 'promoted', promoted)
    const after = await page.evaluate(() => window.joker.generatedTools.get('summarize-task-json'))
    check('v2 is active and capability revision increments', after.success && after.data.summary.activeVersionId !== 'v1' && after.data.capabilityRevision === 2, after)
    const v2 = after.success ? after.data.versions.find((version) => version.id === after.data.summary.activeVersionId) : undefined
    check('v1 remains immutable and edit diff is recorded', after.success && after.data.versions.some((version) => version.id === 'v1' && version.fingerprint === v1.fingerprint) && v2?.editDiff?.baseVersionId === 'v1' && v2.editDiff.sourceChanged === true && v2.editDiff.permissions.expanded === false, after)
  }
  await browser.close()
  browser = undefined
  await stop(electron)
  electron = undefined
  const qualification = expectFailure ? 'toolforge-gate4-edit-failure-electron' : 'toolforge-gate4-edit-success-electron'
  const report = { schemaVersion: 1, qualification, scenario: expectFailure ? 'failure' : 'success', generatedAt: new Date().toISOString(), runDir, isolatedHome: home, checks, providerLog: logPath, passed: checks.every((item) => item.pass) }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ reportPath, passed: report.passed, checks }, null, 2))
} catch (error) {
  failure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) }
  await writeFile(reportPath, `${JSON.stringify({ schemaVersion: 1, qualification: expectFailure ? 'toolforge-gate4-edit-failure-electron' : 'toolforge-gate4-edit-success-electron', scenario: expectFailure ? 'failure' : 'success', generatedAt: new Date().toISOString(), runDir, checks, failure, passed: false }, null, 2)}\n`)
  console.error(JSON.stringify({ reportPath, passed: false, failure }, null, 2))
  process.exitCode = 1
} finally {
  if (browser) await browser.close().catch(() => undefined)
  await stop(electron)
  await stop(provider)
  if (retainDir) {
    await rm(retainDir, { recursive: true, force: true })
    await mkdir(retainDir, { recursive: true })
    await cp(runDir, retainDir, { recursive: true })
  }
}
