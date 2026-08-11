import { chromium } from 'playwright-core'
import { execFileSync, spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const executable = join(root, 'dist', 'win-unpacked', 'JOKER.exe')
const runDir = process.env.JOKER_FRESH_PACKAGED_REPORT_DIR
  ? resolve(process.env.JOKER_FRESH_PACKAGED_REPORT_DIR)
  : await mkdtemp(join(tmpdir(), 'joker-packaged-toolforge-fresh-'))
const home = join(runDir, 'home')
const userData = join(runDir, 'electron-user-data')
const reportPath = join(runDir, 'report.json')
const retainDirArg = process.argv.find((argument) => argument.startsWith('--retain-dir='))
const retainDir = retainDirArg ? resolve(root, retainDirArg.slice('--retain-dir='.length)) : null
const checks = []
const screenshots = []
let child
let browser
let output = ''
let failure = null

function check(name, pass, details = undefined) {
  const result = { name, pass: Boolean(pass), ...(details === undefined ? {} : { details }) }
  checks.push(result)
  if (!result.pass) throw new Error(`Fresh packaged ToolForge qualification failed: ${name}`)
}

function killTree(pid) {
  if (!pid) return
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* best effort */ }
}

async function stopProcess(processHandle) {
  if (!processHandle || processHandle.exitCode !== null) return
  killTree(processHandle.pid)
  await new Promise((resolveWait) => setTimeout(resolveWait, 500))
}

async function screenshot(page, name) {
  const path = join(runDir, `${name}.png`)
  await page.screenshot({ path, fullPage: true })
  screenshots.push(path)
}

async function launchPackaged() {
  output = ''
  child = spawn(executable, [
    `--remote-debugging-port=${20000 + Math.floor(Math.random() * 800)}`,
    `--user-data-dir=${userData}`
  ], {
    cwd: root,
    env: {
      ...process.env,
      JOKER_HOME: home,
      HOME: home,
      USERPROFILE: home,
      ELECTRON_ENABLE_LOGGING: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  const onData = (chunk) => { output += String(chunk) }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)
  const ws = await new Promise((resolveWs, reject) => {
    const findEndpoint = () => {
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (match) resolveWs(match[1])
    }
    child.stdout?.on('data', findEndpoint)
    child.stderr?.on('data', findEndpoint)
    child.once('error', reject)
    child.once('exit', (code, signal) => reject(new Error(`Packaged JOKER exited before CDP: ${code}/${signal}\n${output}`)))
    setTimeout(() => reject(new Error(`Packaged JOKER did not expose CDP\n${output}`)), 30_000)
  })
  browser = await chromium.connectOverCDP(ws)
  const page = browser.contexts()[0]?.pages()[0]
  if (!page) throw new Error('Packaged renderer page was not created')
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.joker?.generatedTools?.list))
  return page
}

async function openGeneratedTools(page) {
  await page.getByRole('button', { name: /设置|Settings/ }).first().click()
  await page.getByRole('button', { name: /自造工具|Generated tools/ }).click()
  await page.getByTestId('generated-tools-empty').waitFor()
}

async function waitForQualification(page, observed) {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    const result = await page.evaluate(() => window.joker.generatedTools.list())
    if (result.success) {
      const operation = result.data.qualificationOperation
      if (operation) observed.push({ status: operation.status, phase: operation.phase, completedChecks: operation.completedChecks })
      if (operation?.status === 'completed') return result
      if (operation?.status === 'failed' || operation?.status === 'cancelled') throw new Error(`qualification ended ${operation.status}: ${operation.error ?? ''}`)
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 300))
  }
  throw new Error('packaged qualification did not complete')
}

try {
  if (process.platform !== 'win32') throw new Error('packaged Windows smoke requires win32')
  if (!existsSync(executable)) throw new Error(`packaged executable not found: ${executable}`)
  await mkdir(home, { recursive: true })
  check('fresh packaged profile has no preexisting qualification report', !existsSync(join(home, '.joker', 'qualification', 'runtime-qualification.json')))
  let page = await launchPackaged()
  const initial = await page.evaluate(() => window.joker.generatedTools.list())
  check('packaged fresh preload exposes an empty inventory', initial.success && initial.data.tools.length === 0, initial)
  check('packaged fresh preload exposes no qualification', initial.success && initial.data.qualification === null)
  check('packaged renderer payload has no host paths', !JSON.stringify(initial).includes(home) && !/artifactPath|logsPath|evidencePath/.test(JSON.stringify(initial)))
  await openGeneratedTools(page)
  check('packaged fresh settings offers Verification', await page.getByTestId('generated-tools-qualification-missing').count() === 1)
  const freshUiText = await page.locator('body').innerText()
  check('packaged default UI uses Verification and hides internal diagnostics', /验证|Verification|Verify/.test(freshUiText) && !/候选|Candidate|指纹|Fingerprint|修订|Revision|Promote/.test(freshUiText), freshUiText)
  await screenshot(page, 'packaged-fresh-before-verification')
  const observed = []
  await page.getByRole('button', { name: /验证 ToolForge|Verify ToolForge/ }).click()
  const qualified = await waitForQualification(page, observed)
  check('packaged host verification completes at real L1', qualified.success && qualified.data.qualification?.level === 'L1', qualified)
  check('packaged progress is observable', observed.some((item) => item.status === 'running' || item.completedChecks > 0), observed)
  check('packaged operation is terminal', qualified.success && qualified.data.qualificationOperation?.status === 'completed')
  await screenshot(page, 'packaged-fresh-after-verification')
  await browser.close()
  browser = undefined
  await stopProcess(child)
  child = undefined
  page = await launchPackaged()
  const restarted = await page.evaluate(() => window.joker.generatedTools.list())
  check('packaged L1 qualification survives restart', restarted.success && restarted.data.qualification?.level === 'L1')
  check('packaged operation is not left running after restart', restarted.success && restarted.data.qualificationOperation?.status === 'completed')
  await openGeneratedTools(page)
  check('packaged restart renders the simple verified ToolForge state', await page.getByTestId('generated-tools-qualification').textContent().then((value) => /已验证|verified/i.test(value ?? '')))
  await screenshot(page, 'packaged-fresh-after-restart')
} catch (error) {
  failure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) }
} finally {
  if (browser) await browser.close().catch(() => undefined)
  await stopProcess(child)
  const report = {
    qualification: 'toolforge-fresh-profile-packaged-windows',
    passed: !failure && checks.every((item) => item.pass),
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    executable,
    runDir,
    home,
    checks,
    screenshots,
    failure,
    packagedOutput: output
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
