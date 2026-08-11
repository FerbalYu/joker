import { chromium } from 'playwright-core'
import { spawn, execFileSync } from 'node:child_process'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { createHash } from 'node:crypto'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const runDir = await mkdtemp(join(tmpdir(), 'joker-electron-toolforge-vertical-slice-'))
const home = join(runDir, 'home')
const workspace = join(runDir, 'project')
const electronUserData = join(runDir, 'electron-user-data')
const logPath = join(runDir, 'fake-provider.log')
const reportPath = join(runDir, 'electron-toolforge-vertical-slice-report.json')
const retainDirArg = process.argv.find((argument) => argument.startsWith('--retain-dir='))
const retainDir = retainDirArg ? resolve(root, retainDirArg.slice('--retain-dir='.length)) : null
const providerPort = 19765 + Math.floor(Math.random() * 500)
const cdpPort = 20200 + Math.floor(Math.random() * 500)
const provider = spawn(process.execPath, [join(root, 'scripts', 'fixtures', 'fake-provider.mjs')], {
  cwd: root,
  env: { ...process.env, PORT: String(providerPort), LOG_PATH: logPath, JOKER_FAKE_SCENARIO: 'toolforge-vertical-slice' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
})
const providerOutput = []
const checks = []
const screenshots = []
let electron
let browser
let page

function check(name, value, details = undefined) {
  const item = { name, pass: Boolean(value), ...(details === undefined ? {} : { details }) }
  checks.push(item)
  if (!item.pass) throw new Error(`${name}: ${JSON.stringify(details ?? value)}`)
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* best effort */ }
  } else {
    child.kill('SIGTERM')
    await Promise.race([once(child, 'exit'), new Promise((resolveWait) => setTimeout(resolveWait, 5_000))])
    if (child.exitCode === null) child.kill('SIGKILL')
  }
}

async function waitForProvider() {
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`Fake provider did not start: ${providerOutput.join('')}`)), 20_000)
    const onData = (chunk) => {
      const text = String(chunk)
      providerOutput.push(text)
      if (text.includes('FAKE_PROVIDER_READY')) {
        clearTimeout(timer)
        resolveReady()
      }
    }
    provider.stdout.on('data', onData)
    provider.stderr.on('data', onData)
    provider.once('error', reject)
  })
}

async function screenshot(name) {
  const path = join(runDir, `${name}.png`)
  await page.screenshot({ path })
  screenshots.push(path)
}

async function launchElectron() {
  const output = []
  electron = spawn(resolve(root, 'node_modules/electron/dist/electron.exe'), [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${electronUserData}`,
    resolve(root, 'out/main/index.js')
  ], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      JOKER_HOME: home,
      ELECTRON_ENABLE_LOGGING: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  const endpoint = new Promise((resolveEndpoint, reject) => {
    const checkEndpoint = () => {
      const match = output.join('').match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (match) resolveEndpoint(match[1])
    }
    const onData = (chunk) => { output.push(String(chunk)); checkEndpoint() }
    electron.stdout.on('data', onData)
    electron.stderr.on('data', onData)
    electron.once('error', reject)
    electron.once('exit', (code, signal) => reject(new Error(`Electron exited before CDP: code=${code} signal=${signal}; output=${output.join('')}`)))
    setTimeout(() => reject(new Error(`Electron did not expose CDP endpoint: ${output.join('')}`)), 20_000)
  })
  const ws = await endpoint
  browser = await chromium.connectOverCDP(ws)
  const context = browser.contexts()[0]
  page = context.pages()[0]
  page.on('console', (message) => {
    if (message.type() === 'error' && !/Autofill\.enable|script-src.*default-src.*fallback/i.test(message.text())) {
      checks.push({ name: 'renderer console error', pass: false, details: message.text() })
    }
  })
  page.on('pageerror', (error) => checks.push({ name: 'renderer page error', pass: false, details: error.message }))
  return output
}

function parseProviderLog(raw) {
  return raw.split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(Boolean)
}

function requestToolNames(entries) {
  const seen = new Set()
  return entries.flatMap((entry) => entry.body?.messages ?? [])
    .filter((message) => message?.role === 'assistant' && Array.isArray(message.tool_calls))
    .flatMap((message) => message.tool_calls)
    .filter((call) => {
      const identity = call?.id ?? `${call?.function?.name}:${call?.function?.arguments}`
      if (!identity || seen.has(identity)) return false
      seen.add(identity)
      return true
    })
    .map((call) => call?.function?.name)
    .filter(Boolean)
}

async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
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

async function installL2RuntimeQualification(home) {
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

await mkdir(join(home, '.joker'), { recursive: true })
await mkdir(join(workspace, 'fixtures'), { recursive: true })
await writeFile(join(workspace, 'fixtures', 'tasks.json'), JSON.stringify([{ status: 'open' }, { status: 'open' }, { status: 'done' }]))
  await installL2RuntimeQualification(home)
  await writeFile(join(home, '.joker', 'config.json'), JSON.stringify({

  providers: [{
    id: 'qa-provider',
    name: 'QA Provider',
    type: 'openai-compatible',
    apiFormat: 'chat-completions',
    baseUrl: `http://127.0.0.1:${providerPort}/v1`,
    apiKey: 'qa-key',
    models: [{ id: 'gpt-4o', name: 'gpt-4o', enabled: true }],
    currentModelId: 'gpt-4o',
    enabled: true
  }],
  activeProviderId: 'qa-provider',
  mcpServers: [],
  skills: [],
  approvalMode: 'full-auto'
}, null, 2))
await writeFile(join(home, '.joker', 'projects.json'), JSON.stringify({
  projects: [{ id: 'electron-vertical-slice-project', name: 'Electron Vertical Slice', path: workspace, lastUsedAt: Date.now() }],
  activeProjectId: 'electron-vertical-slice-project'
}, null, 2))

let failure
try {
  await waitForProvider()
  await launchElectron()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForSelector('textarea')
  check('Electron renderer booted for ToolForge qualification', Boolean(page))

  const session = await page.evaluate(async () => {
    const sessions = await window.joker.session.list()
    return sessions[0] ?? null
  })
  check('A durable conversation session exists', Boolean(session), session)
  if (!session) throw new Error('No session available')
  check('Project workspace is bound to the source session', await page.evaluate(async (sessionId) => window.joker.session.setProject(sessionId, 'electron-vertical-slice-project'), session.id))

  const textarea = page.locator('textarea').first()
  const userTask = '统计当前项目 fixtures/tasks.json 中各状态的任务数量，并按数量排序。'
  await page.evaluate(() => window.joker.approval.setMode('full-auto'))
  await textarea.fill(userTask)
  await screenshot('before-toolforge-task')
  await textarea.press('Enter')
  await page.waitForFunction(() => document.body.innerText.includes('open: 2') && document.body.innerText.includes('done: 1'), undefined, { timeout: 90_000 })
  await screenshot('after-toolforge-task')
  check('Original user task renders the generated Tool result', await page.locator('body').innerText().then((text) => text.includes('open: 2') && text.includes('done: 1')))

  const providerEntries = parseProviderLog(await readFile(logPath, 'utf8'))
  const names = requestToolNames(providerEntries)
  const firstSearch = names.indexOf('ToolSearch')
  const firstStart = names.indexOf('ToolForgeStart')
  const generatedIndex = names.indexOf('electron-vertical-slice-task-summary')
  check('Provider first selects ToolSearch for the real user task', firstSearch >= 0, names)
  check('Provider calls ToolForgeStart after missing capability evidence', firstStart > firstSearch, names)
  check('Model sequence stops at ToolSearch → ToolForgeStart before host-owned activation', names.filter((name) => ['ToolSearch', 'ToolForgeStart', 'ToolForgeStatus', 'ToolPromote'].includes(name)).join(',') === 'ToolSearch,ToolForgeStart', names)
  check('Provider never calls model-owned ToolForgeStatus or ToolPromote', !names.includes('ToolForgeStatus') && !names.includes('ToolPromote'), names)
  check('Continuation first calls the exact enabled Generated Tool', generatedIndex > firstStart, names)
  check('Continuation resumes the original task after host enablement', firstStart >= 0 && generatedIndex === names.length - 1, names)
  check('Continuation makes a real Generated Tool call with a rendered result', generatedIndex >= 0 && await page.locator('body').innerText().then((text) => text.includes('open: 2') && text.includes('done: 1')), names)
  check('ToolSet refreshes without an application restart', generatedIndex > firstStart && names.slice(firstStart + 1).includes('electron-vertical-slice-task-summary'), names)

  const storedSession = await page.evaluate(async (sessionId) => window.joker.session.get(sessionId), session.id)
  const userMessages = storedSession?.messages?.filter((message) => message.role === 'user') ?? []
  check('Only one user message was needed', userMessages.length === 1, userMessages)
  check('Conversation contains a final assistant response', storedSession?.messages?.some((message) => message.role === 'assistant' && String(message.content ?? '').includes('open: 2')))
  check('Settings exposes the enabled Generated Tool and capability revision', await page.evaluate(async () => {
    const result = await window.joker.generatedTools.list()
    return result.success && result.data.capabilityRevision === 1 && result.data.tools.some((tool) => tool.toolId === 'electron-vertical-slice-task-summary' && tool.availability === 'available' && tool.executable)
  }))
  check('Settings explains Generated Tool purpose and current state', await page.evaluate(async () => {
    const result = await window.joker.generatedTools.get('electron-vertical-slice-task-summary')
    return result.success && result.data.summary.description.includes('fixtures/tasks.json') && result.data.summary.availability === 'available'
  }))
  check('Settings explains Generated Tool permissions and validation evidence', await page.evaluate(async () => {
    const result = await window.joker.generatedTools.get('electron-vertical-slice-task-summary')
    if (!result.success) return false
    const active = result.data.versions.find((version) => version.active)
    return active?.manifest.permissions.filesystem.read.includes('fixtures/tasks.json') === true && active.validationReport?.status === 'passed' && active.validationReport.checks.length > 0
  }))
  const conversationSummary = page.getByTestId('toolforge-conversation-summary').last()
  check('Conversation shows ToolForge evidence for the generated Tool', await conversationSummary.count().then((count) => count > 0))
  check('Conversation ToolForge evidence remains visibly rendered', await conversationSummary.isVisible())
  check('Conversation can open the generated Tool Workbench', await conversationSummary.getByTestId('toolforge-open-workbench').count().then((count) => count > 0))

  const generatedRoot = join(home, '.joker', 'generated-tools')
  const registryPath = join(generatedRoot, 'registry.json')
  const invocationsPath = join(generatedRoot, 'invocations.json')
  const continuationsPath = join(generatedRoot, 'continuations-v2.json')
  const journalPath = join(generatedRoot, 'promotion-journal.json')
  check('Durable registry evidence exists', existsSync(registryPath))
  check('Durable host activation journal exists', existsSync(journalPath))
  check('Durable invocation evidence exists', existsSync(invocationsPath))
  check('Durable continuation evidence exists', existsSync(continuationsPath))
  const registry = JSON.parse(await readFile(registryPath, 'utf8'))
  const journals = JSON.parse(await readFile(journalPath, 'utf8'))
  const invocations = JSON.parse(await readFile(invocationsPath, 'utf8'))
  const continuations = JSON.parse(await readFile(continuationsPath, 'utf8'))
  check('Registry records one capability revision and active pointer', registry.capabilityRevision?.revision === 1 && registry.activePointers?.some((pointer) => pointer.toolId === 'electron-vertical-slice-task-summary' && pointer.activeVersionId), registry)
  check('Host activation journal is durably completed', journals.journals?.some((journal) => journal.toolId === 'electron-vertical-slice-task-summary' && journal.phase === 'completed'), journals)
  check('Continuation is durably completed', continuations.continuations?.some((item) => item.toolId === 'electron-vertical-slice-task-summary' && item.status === 'completed'), continuations)
  check('Generated invocation is durably successful', invocations.invocations?.some((item) => item.toolId === 'electron-vertical-slice-task-summary' && item.status === 'finished' && item.outcome === 'succeeded'), invocations)

  const jobRoot = join(generatedRoot, 'jobs')
  const jobDirs = existsSync(jobRoot) ? await readdir(jobRoot) : []
  const jobEvidence = []
  for (const jobId of jobDirs) {
    const path = join(jobRoot, jobId, 'job.json')
    if (existsSync(path)) jobEvidence.push(JSON.parse(await readFile(path, 'utf8')))
  }
  check('ForgeJob evidence reaches completed without claiming original task completion in tool result', jobEvidence.some((job) => job.toolId === 'electron-vertical-slice-task-summary' && job.status === 'completed'), jobEvidence)

  const report = {
    schemaVersion: 1,
    qualification: 'toolforge-vertical-slice-electron',
    generatedAt: new Date().toISOString(),
    runDir,
    isolatedHome: home,
    projectWorkspace: workspace,
    provider: 'local-fake-provider',
    constraints: { externalMcp: 'not-used', publicNetwork: 'not-used', credentials: 'not-used' },
    userTask,
    screenshots,
    providerToolOrder: names,
    checks,
    evidence: {
      registryPath,
      registrySha256: await sha256File(registryPath),
      journalPath,
      journalSha256: await sha256File(journalPath),
      invocationsPath,
      invocationsSha256: await sha256File(invocationsPath),
      continuationsPath,
      continuationsSha256: await sha256File(continuationsPath),
      jobEvidence
    },
    passed: checks.every((item) => item.pass)
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ reportPath, passed: report.passed, checks }, null, 2))
  if (!report.passed) process.exitCode = 1
} catch (error) {
  failure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) }
  const report = { schemaVersion: 1, qualification: 'toolforge-vertical-slice-electron', generatedAt: new Date().toISOString(), runDir, isolatedHome: home, checks, failure, passed: false }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.error(JSON.stringify({ reportPath, passed: false, failure }, null, 2))
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => undefined)
  await stopProcess(electron)
  await stopProcess(provider)
  if (retainDir) {
    await rm(retainDir, { recursive: true, force: true })
    await mkdir(retainDir, { recursive: true })
    await cp(runDir, retainDir, { recursive: true })
  }
}
