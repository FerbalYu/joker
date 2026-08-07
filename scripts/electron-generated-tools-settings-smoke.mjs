import { createHash } from 'node:crypto'
import { chromium } from 'playwright-core'
import { execFileSync, spawn } from 'node:child_process'
import { lstat, mkdtemp, mkdir, cp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { once } from 'node:events'

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

async function fileIdentity(root, relativePath, contents) {
  const path = join(root, ...relativePath.split('/'))
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents)
  const stat = await lstat(path)
  return {
    path: relativePath,
    size: stat.size,
    sha256: createHash('sha256').update(await readFile(path)).digest('hex')
  }
}

async function installQualificationFixture(home) {
  const qualificationRoot = join(home, '.joker', 'qualification')
  await mkdir(qualificationRoot, { recursive: true })
  const candidates = []
  for (const env of ['dev', 'packaged']) {
    const ids = env === 'packaged' ? [...qualificationCases, 'packaged-equivalence'] : qualificationCases
    const cases = []
    for (const id of ids) {
      const evidencePath = `evidence/${env}-${id}.json`
      const evidence = await fileIdentity(qualificationRoot, evidencePath, `${JSON.stringify({ id })}\n`)
      cases.push({ id, status: 'pass', details: `${env} ${id} passed`, evidence })
    }
    candidates.push({ candidate: 'quickjs-wasm', env, passesIsolation: true, cases })
  }
  const quickjsPackage = JSON.parse(await readFile(join(root, 'node_modules', 'quickjs-emscripten', 'package.json'), 'utf8'))
  const artifactIdentity = {
    bundle: await fileIdentity(qualificationRoot, 'artifacts/out/main/index.js', 'fixture-bundle'),
    worker: await fileIdentity(qualificationRoot, 'artifacts/out/main/generated-tool-worker.js', 'fixture-worker'),
    quickjsPackage: {
      ...await fileIdentity(qualificationRoot, 'artifacts/node_modules/quickjs-emscripten/package.json', `${JSON.stringify({ version: quickjsPackage.version })}\n`),
      version: quickjsPackage.version
    },
    packageLock: await fileIdentity(qualificationRoot, 'artifacts/package-lock.json', 'fixture-lock'),
    packaged: {
      executable: await fileIdentity(qualificationRoot, 'artifacts/dist/win-unpacked/JOKER.exe', 'fixture-executable'),
      appAsar: await fileIdentity(qualificationRoot, 'artifacts/dist/win-unpacked/resources/app.asar', 'fixture-asar')
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

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const runDir = await mkdtemp(join(tmpdir(), 'joker-electron-generated-tools-'))
const home = join(runDir, 'home')
const userData = join(runDir, 'electron-user-data')
const reportPath = join(runDir, 'report.json')
const retainDirArg = process.argv.find((argument) => argument.startsWith('--retain-dir='))
const retainDir = retainDirArg ? resolve(root, retainDirArg.slice('--retain-dir='.length)) : null
const checks = []
const screenshots = []
let electron
let browser
let output = ''
let failure = null

function check(name, pass, details = undefined) {
  const result = { name, pass: Boolean(pass), ...(details === undefined ? {} : { details }) }
  checks.push(result)
  if (!result.pass) throw new Error(`Electron Generated Tools qualification failed: ${name}`)
}

function electronExecutable() {
  return join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* best effort */ }
  } else {
    child.kill('SIGTERM')
    await Promise.race([once(child, 'exit'), new Promise((resolveWait) => setTimeout(resolveWait, 5000))])
    if (child.exitCode === null) child.kill('SIGKILL')
  }
}

async function screenshot(page, name) {
  const path = join(runDir, `${name}.png`)
  await page.screenshot({ path, fullPage: true })
  screenshots.push(path)
}

async function launchElectron() {
  output = ''
  electron = spawn(electronExecutable(), [
    `--remote-debugging-port=${20000 + Math.floor(Math.random() * 800)}`,
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
  const onData = (chunk) => { output += String(chunk) }
  electron.stdout?.on('data', onData)
  electron.stderr?.on('data', onData)
  const ws = await new Promise((resolveWs, reject) => {
    const findEndpoint = () => {
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (match) resolveWs(match[1])
    }
    electron.stdout?.on('data', findEndpoint)
    electron.stderr?.on('data', findEndpoint)
    electron.once('error', reject)
    electron.once('exit', (code, signal) => reject(new Error(`Electron exited before CDP: ${code}/${signal}\n${output}`)))
    setTimeout(() => reject(new Error(`Electron did not expose CDP\n${output}`)), 20_000)
  })
  browser = await chromium.connectOverCDP(ws)
  const page = browser.contexts()[0]?.pages()[0]
  if (!page) throw new Error('Electron renderer page was not created')
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.joker?.generatedTools?.list))
  return page
}

async function openGeneratedTools(page) {
  await page.getByRole('button', { name: /设置|Settings/ }).first().click()
  await page.getByRole('button', { name: /自造工具|Generated tools/ }).click()
  await page.getByTestId('generated-tools-inventory').waitFor()
}

try {
  await installQualificationFixture(home)
  let page = await launchElectron()
  const direct = await page.evaluate(() => window.joker.generatedTools.list())
  check('preload returns one fixture tool', direct.success && direct.data.tools.length === 1)
  check('renderer payload has no host paths', !JSON.stringify(direct).includes(home) && !/artifactPath|logsPath|evidencePath/.test(JSON.stringify(direct)))

  await openGeneratedTools(page)
  check('fixture inventory card renders', await page.getByTestId('generated-tool-card-summarize-task-json').count() === 1)
  check('fixture is shown available', await page.getByTestId('generated-tool-status-summarize-task-json').textContent().then((value) => /可用|Available/.test(value ?? '')))
  const saveButtonCount = await page.getByRole('button', { name: /^保存$|^Save$/ }).count()
  check('read-only Generated Tools tab has no Save action', saveButtonCount === 0)
  await screenshot(page, 'generated-tools-inventory')

  const card = page.getByTestId('generated-tool-card-summarize-task-json')
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('joker:open-generated-tool', {
      detail: {
        toolId: 'summarize-task-json',
        focus: 'edit',
        requestedFrom: 'conversation'
      }
    }))
  })
  await page.getByTestId('tool-workbench').waitFor()
  check('conversation event opens the exact Generated Tool Workbench', await page.getByTestId('tool-workbench-status').textContent().then((value) => /可用|Available/.test(value ?? '')))
  check('conversation edit targets the selected specific tool', await page.getByRole('heading', { name: /SummarizeTaskJson|summarize-task-json/i }).count().then((count) => count > 0))
  check('conversation edit entry focuses the immutable-base instruction field', await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'tool-workbench-edit-instruction'))
  await page.getByTestId('tool-workbench-edit-instruction').fill('Use natural language to preserve behavior and improve the implementation.')
  check('natural language edit instruction is accepted for submission', await page.getByTestId('tool-workbench-edit-submit').isEnabled())
  await page.keyboard.press('Escape')
  await page.getByTestId('tool-workbench').waitFor({ state: 'detached' })
  await card.click()
  await page.getByTestId('tool-workbench').waitFor()
  check('Workbench shows available status', await page.getByTestId('tool-workbench-status').textContent().then((value) => /可用|Available/.test(value ?? '')))
  check('Workbench shows all eight validation checks', await page.getByTestId('tool-workbench-validation-checks').locator(':scope > div').count() === 8)
  check('Permissions and retained evidence explanation is visible in the Workbench',
    await page.getByTestId('tool-workbench').getByText('fixtures/tasks.json', { exact: true }).count() === 1 &&
    await page.locator('[data-validation-evidence="retained"]').count() === 8)
  check('Workbench shows immutable version', await page.getByTestId('tool-workbench-versions').getByText('v1', { exact: true }).count() === 1)
  check('Workbench shows empty invocation history honestly', await page.getByTestId('tool-workbench-invocations').textContent().then((value) => /尚无真实调用记录|No real invocation records/.test(value ?? '')))
  await screenshot(page, 'tool-workbench')
  await page.keyboard.press('Escape')
  check('Escape closes Workbench', await page.getByTestId('tool-workbench').count() === 0)
  check('focus returns to selected tool card', await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'generated-tool-card-summarize-task-json'))

  await browser.close()
  browser = undefined
  await stopProcess(electron)
  electron = undefined
  page = await launchElectron()
  const restarted = await page.evaluate(() => window.joker.generatedTools.list())
  check('registry and active version survive restart', direct.success && restarted.success && restarted.data.registryRevision === direct.data.registryRevision && restarted.data.capabilityRevision === direct.data.capabilityRevision && restarted.data.tools[0]?.activeVersionId === direct.data.tools[0]?.activeVersionId)
  await openGeneratedTools(page)
  check('restart inventory still renders fixture', await page.getByTestId('generated-tool-card-summarize-task-json').count() === 1)
  await screenshot(page, 'generated-tools-restart')
} catch (error) {
  failure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) }
} finally {
  if (browser) await browser.close().catch(() => undefined)
  await stopProcess(electron)
  const report = {
    qualification: 'toolforge-settings-electron',
    passed: !failure && checks.every((item) => item.pass),
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    runDir,
    checks,
    screenshots,
    failure,
    electronOutput: output
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  if (retainDir) {
    await rm(retainDir, { recursive: true, force: true })
    await mkdir(retainDir, { recursive: true })
    await cp(runDir, retainDir, { recursive: true })
  }
  console.log(JSON.stringify({ reportPath, retainedReportPath: retainDir ? join(retainDir, 'report.json') : null, runDir, checks, screenshots, failure }, null, 2))
  if (failure || checks.some((item) => !item.pass)) process.exitCode = 1
}
