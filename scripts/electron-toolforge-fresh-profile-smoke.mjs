import { chromium } from 'playwright-core'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile, access, cp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { once } from 'node:events'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const runDir = await mkdtemp(join(tmpdir(), 'joker-electron-toolforge-fresh-'))
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
  if (!result.pass) throw new Error(`Fresh ToolForge Electron qualification failed: ${name}`)
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
      HOME: home,
      USERPROFILE: home,
      ELECTRON_ENABLE_LOGGING: '1',
      JOKER_INSTALL_TOOLFORGE_FIXTURE: ''
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
  await page.getByTestId('generated-tools-empty').waitFor()
}

async function waitForQualification(page, observed) {
  await page.waitForFunction(() => {
    const operation = document.querySelector('[data-testid="generated-tools-qualification-running"]')
    return Boolean(operation)
  }, undefined, { timeout: 5_000 }).catch(() => undefined)
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const result = await page.evaluate(() => window.joker.generatedTools.list())
    if (result.success) {
      const operation = result.data.qualificationOperation
      if (operation) observed.push({ status: operation.status, phase: operation.phase, completedChecks: operation.completedChecks })
      if (operation?.status === 'completed') return result
      if (operation?.status === 'failed' || operation?.status === 'cancelled') throw new Error(`qualification ended ${operation.status}: ${operation.error ?? ''}`)
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error('qualification did not complete')
}

try {
  await mkdir(home, { recursive: true })
  check('fresh profile has no preexisting qualification report', !existsSync(join(home, '.joker', 'qualification', 'runtime-qualification.json')))
  let page = await launchElectron()
  const initial = await page.evaluate(() => window.joker.generatedTools.list())
  check('fresh preload exposes an empty inventory', initial.success && initial.data.tools.length === 0, initial)
  check('fresh preload exposes no qualification', initial.success && initial.data.qualification === null)
  check('renderer payload has no host paths', !JSON.stringify(initial).includes(home) && !/artifactPath|logsPath|evidencePath/.test(JSON.stringify(initial)))
  await openGeneratedTools(page)
  check('fresh settings offers Verification action', await page.getByTestId('generated-tools-qualification-missing').count() === 1)
  check('fresh settings shows empty inventory', await page.getByTestId('generated-tools-empty').count() === 1)
  const freshUiText = await page.locator('body').innerText()
  check('fresh default UI uses Verification and hides internal diagnostics', /验证|Verification|Verify/.test(freshUiText) && !/候选|Candidate|指纹|Fingerprint|修订|Revision|Promote/.test(freshUiText), freshUiText)
  await screenshot(page, 'fresh-before-verification')
  const observed = []
  await page.getByRole('button', { name: /验证 ToolForge|Verify ToolForge/ }).click()
  const qualified = await waitForQualification(page, observed)
  check('host verification completes at L1', qualified.success && qualified.data.qualification?.level === 'L1', qualified)
  check('qualification progress is observable', observed.some((item) => item.status === 'running' || item.completedChecks > 0), observed)
  check('operation is terminal after completion', qualified.success && qualified.data.qualificationOperation?.status === 'completed')
  await screenshot(page, 'fresh-after-verification')
  await browser.close()
  browser = undefined
  await stopProcess(electron)
  electron = undefined
  page = await launchElectron()
  const restarted = await page.evaluate(() => window.joker.generatedTools.list())
  check('L1 qualification survives restart', restarted.success && restarted.data.qualification?.level === 'L1')
  check('qualification operation does not remain running after restart', restarted.success && restarted.data.qualificationOperation?.status === 'completed')
  check('inventory remains empty until a user creates a tool', restarted.success && restarted.data.tools.length === 0)
  await openGeneratedTools(page)
  check('restart settings still exposes the simple verified ToolForge state', await page.getByTestId('generated-tools-qualification').textContent().then((value) => /已验证|verified/i.test(value ?? '')))
  await screenshot(page, 'fresh-after-restart')
} catch (error) {
  failure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) }
} finally {
  if (browser) await browser.close().catch(() => undefined)
  await stopProcess(electron)
  const report = {
    qualification: 'toolforge-fresh-profile-electron',
    passed: !failure && checks.every((item) => item.pass),
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    runDir,
    home,
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
