import { chromium } from 'playwright-core'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { once } from 'node:events'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const runDir = await mkdtemp(join(tmpdir(), 'joker-subagent-observability-smoke-'))
const home = join(runDir, 'home')
const electronUserData = join(runDir, 'electron-user-data')
const providerLogPath = join(runDir, 'fake-provider.log')
const reportPath = join(runDir, 'report.json')
const providerPort = 24100 + Math.floor(Math.random() * 300)
const cdpPort = 24500 + Math.floor(Math.random() * 300)
const checks = []
const screenshots = []
const consoleErrors = []
const pageErrors = []
let provider
let electron
let browser
let electronOutput = []
let failure = null

function check(name, value, details) {
  checks.push({ name, pass: Boolean(value), ...(details === undefined ? {} : { details }) })
  if (!value) throw new Error(`Electron subagent observability smoke failed: ${name}`)
}

async function waitFor(predicate, timeoutMs = 20_000, description = 'condition') {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try { if (await predicate()) return } catch (error) { lastError = error }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${description}${lastError instanceof Error ? `: ${lastError.message}` : ''}`)
}

async function screenshot(page, name) {
  const path = join(runDir, `${name}.png`)
  await page.screenshot({ path })
  screenshots.push(path)
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* best effort */ }
  } else {
    child.kill('SIGTERM')
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))])
    if (child.exitCode === null) child.kill('SIGKILL')
  }
}

async function launchElectron() {
  electronOutput = []
  electron = spawn(resolve(root, 'node_modules/electron/dist/electron.exe'), [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${electronUserData}`,
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
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback(value)
    }
    const inspect = () => {
      const match = electronOutput.join('').match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (match) finish(resolveWs, match[1])
    }
    electron.stdout.on('data', inspect)
    electron.stderr.on('data', inspect)
    electron.once('error', (error) => finish(reject, error))
    electron.once('exit', (code, signal) => finish(reject, new Error(`Electron exited before CDP: ${code}/${signal}; ${electronOutput.join('')}`)))
    const timer = setTimeout(() => finish(reject, new Error(`Electron did not expose CDP: ${electronOutput.join('')}`)), 20_000)
    inspect()
  })
  browser = await chromium.connectOverCDP(ws)
  const context = browser.contexts()[0]
  await waitFor(() => context.pages().length > 0, 10_000, 'renderer page')
  const page = context.pages()[0]
  page.on('console', (message) => {
    if (message.type() === 'error' && !/Autofill\.enable|ResizeObserver|script-src.*default-src/i.test(message.text())) consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.joker?.session?.list))
  await waitFor(async () => (await page.evaluate(() => window.joker.session.list())).length > 0, 20_000, 'initial session')
  return page
}

async function closeElectron() {
  if (browser) await browser.close().catch(() => undefined)
  browser = null
  await stopProcess(electron)
  electron = null
}

async function persistedActivity() {
  const sessionDir = join(home, '.joker', 'sessions')
  const sessionFiles = (await readdir(sessionDir)).filter((name) => name.endsWith('.json'))
  if (sessionFiles.length !== 1) return null
  const envelope = JSON.parse(await readFile(join(sessionDir, sessionFiles[0]), 'utf8'))
  for (const message of envelope.data.messages) {
    const tools = message.segments?.flatMap((segment) => segment.type === 'tools' ? segment.tools : []) ?? message.toolCalls ?? []
    const activity = tools.find((tool) => tool.toolName === 'Agent')?.metadata?.subagentActivity
    if (activity) return activity
  }
  return null
}

try {
  provider = spawn(process.execPath, [join(root, 'scripts', 'fixtures', 'fake-provider.mjs')], {
    cwd: root,
    env: { ...process.env, PORT: String(providerPort), LOG_PATH: providerLogPath, JOKER_FAKE_SCENARIO: 'subagent-observability', JOKER_FAKE_STREAM_DELAY_MS: '500' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  await new Promise((resolveReady, reject) => {
    const onData = (chunk) => { if (String(chunk).includes('FAKE_PROVIDER_READY')) resolveReady() }
    provider.stdout.on('data', onData)
    provider.stderr.on('data', onData)
    provider.once('error', reject)
    provider.once('exit', (code, signal) => reject(new Error(`Fake Provider exited before ready: ${code}/${signal}`)))
  })

  await mkdir(join(home, '.joker'), { recursive: true })
  await mkdir(electronUserData, { recursive: true })
  await writeFile(join(home, '.joker', 'config.json'), JSON.stringify({
    providers: [{
      id: 'qa-provider', name: 'QA Provider', type: 'openai-compatible', apiFormat: 'chat-completions',
      baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'qa-chat-key',
      models: [{ id: 'gpt-4o', name: 'gpt-4o', enabled: true }], currentModelId: 'gpt-4o', enabled: true
    }],
    activeProviderId: 'qa-provider', mcpServers: [], disabledSkills: []
  }, null, 2))
  await writeFile(join(home, '.joker', 'projects.json'), JSON.stringify({
    projects: [{ id: 'qa-project-0001', name: 'joker', path: root, lastUsedAt: Date.now() }],
    activeProjectId: 'qa-project-0001'
  }, null, 2))

  let page = await launchElectron()
  const binding = await page.evaluate(async () => {
    const projects = await window.joker.project.get()
    const sessions = await window.joker.session.list()
    const projectId = projects.state?.activeProjectId
    const sessionId = sessions[0]?.id
    return { projectId, sessionId, saved: Boolean(projectId && sessionId && await window.joker.session.setProject(sessionId, projectId)) }
  })
  check('smoke session is bound to the workspace', binding.saved, binding)
  await closeElectron()
  page = await launchElectron()
  await page.waitForFunction(() => document.body.innerText.includes('joker'))
  await waitFor(async () => {
    const textarea = page.locator('textarea').first()
    return await textarea.isVisible() && await textarea.isEnabled() && !((await page.locator('body').innerText()).includes('会话仍在加载'))
  }, 20_000, 'session and send controls ready after reload')
  const textarea = page.locator('textarea').first()
  await textarea.fill('Use a subagent to inspect the project identity.')
  await waitFor(async () => {
    const providerLog = await readFile(providerLogPath, 'utf8')
    if (providerLog.includes('"method":"POST"')) return true
    const sendButton = page.getByRole('button', { name: /发送|Send/ })
    if (await sendButton.isEnabled()) {
      if (!(await textarea.inputValue()).trim()) await textarea.fill('Use a subagent to inspect the project identity.')
      await sendButton.click()
    }
    return false
  }, 60_000, 'first provider request after session readiness')
  await page.getByRole('button', { name: /允许|Allow/ }).click({ timeout: 20_000 })
  await page.locator('[data-subagent-status="running"]').waitFor({ state: 'visible', timeout: 20_000 })
  check('running subagent activity is visible before completion', true)
  await page.locator('[data-subagent-tool="Read"]').waitFor({ state: 'visible', timeout: 20_000 })
  check('nested Read tool activity is visible', true)
  await page.locator('[data-subagent-status="completed"]').waitFor({ state: 'visible', timeout: 30_000 })
  await waitFor(async () => (await persistedActivity())?.status === 'completed', 15_000, 'persisted subagent activity')
  const activity = await persistedActivity()
  check('completed activity persists task, tools, result, and usage', activity?.task.includes('package.json') && activity.tools?.some((tool) => tool.toolName === 'Read' && tool.status === 'done') && activity.outputPreview?.includes('JOKER') && activity.usage?.stepCount > 0, activity)
  await page.locator('[data-subagent-status="completed"] summary').click()
  check('observable-work disclosure is visible', await page.locator('[data-subagent-status="completed"]').innerText().then((text) => /隐藏思维|hidden model reasoning/i.test(text)))
  await screenshot(page, 'subagent-completed')

  await closeElectron()
  page = await launchElectron()
  await page.locator('[data-subagent-status="completed"]').waitFor({ state: 'visible', timeout: 20_000 })
  await page.locator('[data-subagent-status="completed"] summary').click()
  check('completed subagent activity is restored after Electron restart', await page.locator('[data-subagent-tool="Read"]').isVisible())
  check('renderer has no relevant console errors', consoleErrors.length === 0, consoleErrors)
  check('renderer has no page errors', pageErrors.length === 0, pageErrors)
  await screenshot(page, 'subagent-restored')
} catch (error) {
  failure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) }
  try {
    const page = browser?.contexts()?.[0]?.pages()?.[0]
    if (page) await screenshot(page, 'subagent-failure')
  } catch { /* best effort */ }
} finally {
  await closeElectron()
  await stopProcess(provider)
  const report = { generatedAt: new Date().toISOString(), runDir, checks, screenshots, consoleErrors, pageErrors, failure, electronOutput }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ reportPath, runDir, checks, screenshots, failure }, null, 2))
  if (failure || checks.some((item) => !item.pass)) process.exitCode = 1
}
