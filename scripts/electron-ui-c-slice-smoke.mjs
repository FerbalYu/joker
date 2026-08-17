// Real-chain verification for the C slice:
//  C1 timeline: minimap renders duration-proportional blocks with timing tooltips.
//  C2 structured questions: model calls AskUserQuestion -> question card -> answer
//     flows back as the tool result -> model continues with the chosen answer.
import { chromium } from 'playwright-core'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { once } from 'node:events'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const runDir = await mkdtemp(join(tmpdir(), 'joker-electron-ui-c-'))
const home = join(runDir, 'home')
const logPath = join(runDir, 'fake-provider.log')
const reportPath = join(runDir, 'report.json')
const providerPort = 26200 + Math.floor(Math.random() * 400)
const cdpPort = 26700 + Math.floor(Math.random() * 400)
const checks = []
const screenshots = []
const consoleErrors = []
const pageErrors = []

function check(name, value, details = undefined) {
  const result = { name, pass: Boolean(value), ...(details === undefined ? {} : { details }) }
  checks.push(result)
  if (!result.pass) throw new Error(`UI C smoke failed: ${name}`)
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

let provider
let electron
let browser
let failure = null
try {
  provider = spawn(process.execPath, [join(root, 'scripts', 'fixtures', 'fake-provider.mjs')], {
    cwd: root,
    env: { ...process.env, PORT: String(providerPort), LOG_PATH: logPath, JOKER_FAKE_SCENARIO: 'ask-question' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  const providerOutput = []
  const providerReady = new Promise((resolveReady, reject) => {
    const onData = (chunk) => {
      const text = String(chunk)
      providerOutput.push(text)
      if (text.includes('FAKE_PROVIDER_READY')) resolveReady()
    }
    provider.stdout.on('data', onData)
    provider.stderr.on('data', onData)
    provider.once('error', reject)
    provider.once('exit', (code, signal) => {
      if (code !== 0) reject(new Error(`Fake Provider exited before ready: ${code}/${signal}; ${providerOutput.join('')}`))
    })
  })
  await providerReady

  await mkdir(join(home, '.joker'), { recursive: true })
  await writeFile(join(home, '.joker', 'config.json'), JSON.stringify({
    providers: [{
      id: 'qa-provider',
      name: 'QA Question Provider',
      type: 'openai-compatible',
      apiFormat: 'chat-completions',
      baseUrl: `http://127.0.0.1:${providerPort}/v1`,
      apiKey: 'qa-question-key',
      models: [{ id: 'gpt-4o', name: 'gpt-4o', enabled: true }],
      currentModelId: 'gpt-4o',
      enabled: true
    }],
    activeProviderId: 'qa-provider',
    mcpServers: [],
    approvalMode: 'suggest'
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
  const context = browser.contexts()[0]
  const page = context.pages()[0]
  page.on('console', (message) => {
    if (message.type() === 'error' && !/Autofill\.enable|script-src.*default-src.*fallback/i.test(message.text())) consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.joker?.session?.list))
  await page.waitForSelector('textarea', { timeout: 30_000 })
  await page.waitForTimeout(1_000)

  // ---- C2: the model raises a structured question mid-run.
  const textarea = page.locator('textarea').first()
  await textarea.fill('Please decide the release strategy for me')
  await textarea.press('Enter')
  await page.waitForSelector('[data-user-question-panel]', { timeout: 60_000 })
  const panel = page.locator('[data-user-question-panel]')
  const questionText = await panel.innerText()
  check('question card shows the model question', questionText.includes('ASK_QUESTION_7781'), questionText)
  check('question card renders the two options', (await panel.locator('[data-question-option]').count()) === 2, questionText)
  check('question card exposes the free-text input', (await panel.locator('[data-question-free-text]').count()) === 1)

  // Choose "Fast mode" and submit.
  await panel.locator('[data-question-option]', { hasText: 'Fast mode' }).click()
  const pressed = await panel.locator('[data-question-option]').evaluateAll((nodes) => nodes.filter((node) => node.getAttribute('aria-pressed') === 'true').map((node) => node.innerText))
  check('selecting an option marks it pressed', pressed.length === 1 && pressed[0].includes('Fast mode'), pressed)
  await panel.locator('[data-question-submit]').click()

  // The tool result returns to the model, which answers using the choice.
  await page.waitForFunction(() => document.body.innerText.includes('AskUserQuestion round trip completed.'), undefined, { timeout: 60_000 })
  const bodyAfterAnswer = await page.evaluate(() => document.body.innerText)
  check('model continuation names the chosen answer', bodyAfterAnswer.includes('The user chose: Fast mode'), bodyAfterAnswer.slice(0, 600))
  check('question card closes after answering', (await page.locator('[data-user-question-panel]').count()) === 0)
  await page.screenshot({ path: join(runDir, 'question-answered.png') })
  screenshots.push(join(runDir, 'question-answered.png'))

  // The tool result payload recorded what the user picked.
  const firstSessionId = await page.evaluate(async () => (await window.joker.session.list())[0]?.id ?? '')
  const requests = (await readFile(logPath, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  const chatRequests = requests.filter((entry) => entry.body?.stream === true)
  check('ask-question run made both model requests', chatRequests.length >= 2, { count: chatRequests.length })
  const secondRequest = chatRequests[1]?.body
  const serialized = JSON.stringify(secondRequest?.messages ?? [])
  check('answer returns to the model as the AskUserQuestion tool result', serialized.includes('AskUserQuestion') && serialized.includes('Fast mode'))

  // ---- C2 skip path on a fresh session.
  const secondSession = await page.evaluate(() => window.joker.session.create('Skip path QA').then((session) => session.id))
  await page.waitForSelector(`[data-session-id="${secondSession}"]`, { timeout: 10_000 })
  await page.click(`[data-session-id="${secondSession}"] button`)
  await page.waitForTimeout(1_500)
  await page.waitForFunction(() => !document.body.innerText.includes('会话仍在加载') && !document.body.innerText.includes('conversation is still loading'), undefined, { timeout: 30_000 })
  await textarea.fill('Decide the release strategy again')
  await textarea.press('Enter')
  try {
    await page.waitForSelector('[data-user-question-panel]', { timeout: 60_000 })
  } catch (error) {
    const bodyText = await page.evaluate(() => document.body.innerText)
    throw new Error(`Second-session question card never appeared. Body excerpt: ${bodyText.slice(0, 1200)}`)
  }
  const skipPanel = page.locator('[data-user-question-panel]')
  await skipPanel.locator('button', { hasText: /跳过|Skip/ }).click()
  await page.waitForFunction(() => document.body.innerText.includes('dismissed by the user'), undefined, { timeout: 60_000 })
  check('skip path lets the model continue after dismissal', true)

  // ---- C1: timeline renders duration-proportional blocks.
  // Back to the first session so the minimap covers both answered turns.
  check('first session id captured', Boolean(firstSessionId), firstSessionId)
  const switched = await page.evaluate((sessionId) => window.joker.session.get(sessionId).then((session) => Boolean(session && session.messages.length >= 2)), firstSessionId)
  check('first session still holds the answered turn', switched)
  await page.click(`[data-session-id="${firstSessionId}"]`)
  await page.waitForFunction((sessionId) => {
    const detail = document.querySelector('[data-token-ledger]')
    return Boolean(detail) || document.querySelectorAll('[data-message-row]').length >= 2
  }, firstSessionId, { timeout: 30_000 })
  await page.waitForTimeout(500)
  const minimap = page.locator('[data-message-minimap]')
  try {
    await minimap.waitFor({ state: 'visible', timeout: 10_000 })
  } catch (error) {
    const bodyText = await page.evaluate(() => document.body.innerText)
    const messageCount = await page.evaluate(() => document.querySelectorAll('[data-message-row]').length)
    throw new Error(`Minimap never appeared. messageRows=${messageCount}. Body excerpt: ${bodyText.slice(0, 900)}`)
  }
  const minimapGeometry = await page.evaluate(() => {
    const aside = document.querySelector('[data-message-minimap]')
    const track = aside?.querySelector('div')
    return {
      asideRect: aside ? aside.getBoundingClientRect().toJSON() : null,
      trackClientHeight: track ? track.clientHeight : null,
      buttonCount: aside ? aside.querySelectorAll('button').length : 0,
      entryCount: aside ? aside.getAttribute('data-minimap-entries') : null,
      trackHeightState: aside ? aside.getAttribute('data-minimap-track-height') : null
    }
  })
  const blocks = await page.evaluate(() => [...document.querySelectorAll('[data-message-minimap] button > span')].map((span) => ({ className: span.className, style: span.getAttribute('style') })))
  const durationBlocks = blocks.filter((block) => String(block.className).includes('text-secondary'))
  check('minimap renders duration-proportional blocks', durationBlocks.length >= 1, { geometry: minimapGeometry, blocks: JSON.stringify(blocks).slice(0, 600), durationBlocks: durationBlocks.length })
  const ariaLabels = await page.evaluate(() => [...document.querySelectorAll('[data-message-minimap] button')].map((button) => button.getAttribute('aria-label') ?? ''))
  check('timeline tooltips expose per-turn durations', ariaLabels.some((label) => /耗时|/.test(label) || /\d+(\.\d+)?(ms|s)/.test(label)), ariaLabels.slice(0, 4))
  await page.screenshot({ path: join(runDir, 'timeline-blocks.png') })
  screenshots.push(join(runDir, 'timeline-blocks.png'))

  check('ui C leaves no renderer console errors', consoleErrors.length === 0, consoleErrors)
  check('ui C leaves no renderer page errors', pageErrors.length === 0, pageErrors)
} catch (error) {
  failure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) }
} finally {
  if (browser) await browser.close().catch(() => undefined)
  await stopProcess(electron)
  await stopProcess(provider)
  const report = { generatedAt: new Date().toISOString(), runDir, checks, screenshots, failure, consoleErrors, pageErrors }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ reportPath, runDir, checks, screenshots, failure }, null, 2))
  if (failure || checks.some((item) => !item.pass)) process.exitCode = 1
}
