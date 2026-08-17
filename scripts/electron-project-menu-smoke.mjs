import { chromium } from 'playwright-core'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const runDir = await mkdtemp(join(tmpdir(), 'joker-project-menu-'))
const home = join(runDir, 'home')
const reportPath = join(runDir, 'report.json')
const cdpPort = 28900 + Math.floor(Math.random() * 400)
const checks = []
const consoleErrors = []
const pageErrors = []
let electron
let browser
let failure = null

function check(name, value, details = undefined) {
  const result = { name, pass: Boolean(value), ...(details === undefined ? {} : { details }) }
  checks.push(result)
  if (!result.pass) throw new Error(`Project menu smoke failed: ${name}`)
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

try {
  const projectA = join(runDir, 'project-a')
  const projectB = join(runDir, 'project-b')
  await mkdir(join(home, '.joker'), { recursive: true })
  await mkdir(projectA, { recursive: true })
  await mkdir(projectB, { recursive: true })
  await writeFile(join(home, '.joker', 'config.json'), JSON.stringify({
    providers: [],
    activeProviderId: null,
    mcpServers: [],
    approvalMode: 'suggest'
  }, null, 2))
  await writeFile(join(home, '.joker', 'projects.json'), JSON.stringify({
    projects: [
      { id: 'proj-alpha', name: 'Alpha Repo', path: projectA, lastUsedAt: Date.now() },
      { id: 'proj-beta', name: 'Beta Repo', path: projectB, lastUsedAt: Date.now() - 1_000 }
    ],
    activeProjectId: null
  }, null, 2))

  const electronOutput = []
  electron = spawn(resolve(root, 'node_modules/electron/dist/electron.exe'), [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${join(runDir, 'electron-user-data')}`,
    resolve(root, 'out/main/index.js')
  ], {
    cwd: root,
    env: { ...process.env, HOME: home, USERPROFILE: home, JOKER_HOME: home, ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  const onData = (chunk) => electronOutput.push(String(chunk))
  electron.stdout.on('data', onData)
  electron.stderr.on('data', onData)
  const ws = await new Promise((resolveWs, reject) => {
    const inspect = () => {
      const match = electronOutput.join('').match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (match) resolveWs(match[1])
    }
    electron.stdout.on('data', inspect)
    electron.stderr.on('data', inspect)
    electron.once('error', reject)
    electron.once('exit', (code, signal) => reject(new Error(`Electron exited before CDP: ${code}/${signal}; ${electronOutput.join('')}`)))
    setTimeout(() => reject(new Error(`Electron did not expose CDP endpoint: ${electronOutput.join('')}`)), 20_000)
    inspect()
  })

  browser = await chromium.connectOverCDP(ws)
  const page = browser.contexts()[0].pages()[0]
  page.on('console', (message) => {
    if (message.type() === 'error' && !/Autofill\.enable|script-src.*default-src.*fallback/i.test(message.text())) consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.joker?.session?.create && window.joker?.project?.get))
  await page.waitForSelector('[data-input-composer]', { timeout: 30_000 })

  const sessionId = await page.evaluate(() => window.joker.session.create('Project menu QA').then((session) => session.id))
  await page.waitForSelector(`[data-session-id="${sessionId}"]`, { timeout: 10_000 })
  await page.click(`[data-session-id="${sessionId}"]`)
  await page.waitForTimeout(500)

  const composer = page.locator('[data-input-composer]')
  const trigger = composer.locator('button').filter({ hasText: /未选择工作文件夹|No working folder/i }).first()
  check('working-folder trigger is visible and enabled', await trigger.isVisible() && await trigger.isEnabled())
  await trigger.click()

  const alphaOption = page.getByRole('button', { name: /Alpha Repo/i })
  check('clicking the trigger opens the saved project list', await alphaOption.isVisible())
  await alphaOption.click()
  await page.waitForFunction(() => document.querySelector('[data-input-composer]')?.textContent?.includes('Alpha Repo'))

  const alphaState = await page.evaluate(async (activeSessionId) => ({
    project: await window.joker.project.get(),
    session: await window.joker.session.get(activeSessionId)
  }), sessionId)
  check('clicking Alpha Repo updates the visible selection', (await composer.innerText()).includes('Alpha Repo'))
  check('clicking Alpha Repo persists the active project and session binding', alphaState.project.state?.activeProjectId === 'proj-alpha' && alphaState.session?.projectId === 'proj-alpha', alphaState)

  await composer.locator('button').filter({ hasText: /Alpha Repo/i }).first().click()
  const betaOption = page.getByRole('button', { name: /Beta Repo/i })
  check('the menu remains operable after the first selection', await betaOption.isVisible())
  await betaOption.click()
  await page.waitForFunction(() => document.querySelector('[data-input-composer]')?.textContent?.includes('Beta Repo'))
  const betaSession = await page.evaluate((activeSessionId) => window.joker.session.get(activeSessionId), sessionId)
  check('a second project click changes the session binding', betaSession?.projectId === 'proj-beta', betaSession)

  const screenshotPath = join(runDir, 'project-selected.png')
  await page.screenshot({ path: screenshotPath })
  check('renderer has no related console errors', consoleErrors.length === 0, consoleErrors)
  check('renderer has no page errors', pageErrors.length === 0, pageErrors)
  await writeFile(reportPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), runDir, screenshotPath, checks, consoleErrors, pageErrors }, null, 2)}\n`)
} catch (error) {
  failure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) }
  await writeFile(reportPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), runDir, checks, consoleErrors, pageErrors, failure }, null, 2)}\n`)
} finally {
  if (browser) await browser.close().catch(() => undefined)
  await stopProcess(electron)
  console.log(JSON.stringify({ reportPath, runDir, checks, consoleErrors, pageErrors, failure }, null, 2))
  if (failure || checks.some((item) => !item.pass)) process.exitCode = 1
}
