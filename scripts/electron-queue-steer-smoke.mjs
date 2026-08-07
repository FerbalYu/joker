import { chromium } from 'playwright-core'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { once } from 'node:events'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const runDir = await mkdtemp(join(tmpdir(), 'joker-electron-queue-steer-'))
const home = join(runDir, 'home')
const electronUserData = join(runDir, 'electron-user-data')
const providerLogPath = join(runDir, 'fake-provider.log')
const reportPath = join(runDir, 'report.json')
const providerPort = 21800 + Math.floor(Math.random() * 400)
const cdpPort = 22300 + Math.floor(Math.random() * 400)
const checks = []
const screenshots = []
const consoleErrors = []
const pageErrors = []
let failure = null
let provider
let electron
let browser
let providerOutput = []
let electronOutput = []

function check(name, value, details = undefined) {
  const result = { name, pass: Boolean(value), ...(details === undefined ? {} : { details }) }
  checks.push(result)
  if (!result.pass) throw new Error(`Electron queue/steer smoke failed: ${name}`)
}

async function waitFor(predicate, timeoutMs = 10_000, description = 'condition') {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
    } catch (error) {
      lastError = error
    }
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

async function providerEntries() {
  try {
    return (await readFile(providerLogPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

try {
  provider = spawn(process.execPath, [join(root, 'scripts', 'fixtures', 'fake-provider.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(providerPort),
      LOG_PATH: providerLogPath,
      JOKER_FAKE_SCENARIO: 'queue-steer',
      JOKER_FAKE_STREAM_DELAY_MS: '500',
      JOKER_FAKE_NEXT_STEP_DELAY_MS: '4000'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
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
  await mkdir(electronUserData, { recursive: true })
  await writeFile(join(home, '.joker', 'config.json'), JSON.stringify({
    providers: [{
      id: 'qa-provider',
      name: 'QA Queue Steer Provider',
      type: 'openai-compatible',
      apiFormat: 'chat-completions',
      baseUrl: `http://127.0.0.1:${providerPort}/v1`,
      apiKey: 'qa-queue-steer-key',
      models: [{ id: 'gpt-4o', name: 'gpt-4o', enabled: true, maxContextTokens: 262144 }],
      currentModelId: 'gpt-4o',
      enabled: true,
      promptCache: false
    }],
    activeProviderId: 'qa-provider',
    mcpServers: [],
    disabledSkills: []
  }, null, 2))

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
  const onElectronData = (chunk) => electronOutput.push(String(chunk))
  electron.stdout.on('data', onElectronData)
  electron.stderr.on('data', onElectronData)
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
    electron.once('exit', (code, signal) => finish(reject, new Error(`Electron exited before CDP: code=${code} signal=${signal}; output=${electronOutput.join('')}`)))
    const timer = setTimeout(() => finish(reject, new Error(`Electron did not expose CDP endpoint: ${electronOutput.join('')}`)), 20_000)
    inspect()
  })

  browser = await chromium.connectOverCDP(ws)
  const context = browser.contexts()[0]
  await waitFor(() => context.pages().length > 0, 10_000, 'renderer page')
  const page = context.pages()[0]
  page.on('console', (message) => {
    if (message.type() === 'error' && !/ResizeObserver loop|Autofill\.enable|script-src.*default-src.*fallback/i.test(message.text())) {
      consoleErrors.push({ text: message.text(), location: message.location() })
    }
  })
  page.on('pageerror', (error) => pageErrors.push({ name: error.name, message: error.message, stack: error.stack }))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.joker?.session?.list))
  await waitFor(async () => (await page.evaluate(() => window.joker.session.list())).length > 0, 20_000, 'initial session')

  const textarea = page.locator('textarea').first()
  await textarea.fill('QUEUE_STEER_BASE_7781')
  await textarea.press('Enter')
  await page.waitForFunction(() => document.querySelector('textarea')?.disabled === false && Boolean(document.querySelector('[data-run-status]')), undefined, { timeout: 10_000 })
  const alignment = await page.evaluate(() => {
    const composer = document.querySelector('[data-input-composer]')
    const textarea = composer?.querySelector('textarea')
    const controls = composer ? [...composer.querySelectorAll('button')].filter((button) => button.getBoundingClientRect().height === 32) : []
    const boxes = textarea && controls.length > 0 ? [textarea, ...controls].map((element) => element.getBoundingClientRect()) : []
    const bottoms = boxes.map((box) => box.bottom)
    const heights = boxes.map((box) => box.height)
    return {
      controlCount: boxes.length,
      bottomSpread: bottoms.length > 0 ? Math.max(...bottoms) - Math.min(...bottoms) : null,
      heights,
      runActions: [...document.querySelectorAll('[data-run-action]')].map((element) => element.getAttribute('data-run-action'))
    }
  })
  check('empty running draft shows only the stop action', alignment.controlCount >= 2 && alignment.runActions.length === 1 && alignment.runActions[0] === 'stop', alignment)
  check('composer controls stay bottom-aligned during a run', alignment.bottomSpread !== null && alignment.bottomSpread <= 2, alignment)

  await waitFor(async () => (await page.locator('[data-run-status="awaiting-approval"]').count()) === 1, 20_000, 'approval-safe tool boundary')
  check('tool execution exposes a visible approval status', await page.locator('[data-run-status="awaiting-approval"]').count() === 1)

  await textarea.fill('QUEUE_FOLLOWUP_7781')
  check('typing during a run switches to the single queue action', await page.locator('[data-run-action="queue"]').count() === 1 && await page.locator('[data-run-action="stop"]').count() === 0)
  await textarea.press('Enter')
  await waitFor(async () => (await page.locator('[data-pending-message]').allTextContents()).some((text) => text.includes('QUEUE_FOLLOWUP_7781')), 10_000, 'queued follow-up row')
  const pendingLayout = await page.evaluate(() => {
    const composer = document.querySelector('[data-input-composer]')
    const list = document.querySelector('[data-pending-message-list]')
    const row = document.querySelector('[data-pending-message]')
    const steer = row?.querySelector('[data-steer-pending]')
    if (!composer || !list || !row || !steer) return null
    const composerBox = composer.getBoundingClientRect()
    const listBox = list.getBoundingClientRect()
    const rowBox = row.getBoundingClientRect()
    const steerBox = steer.getBoundingClientRect()
    return {
      insideComposer: composer.contains(list),
      aboveComposer: listBox.bottom <= composerBox.top + 1,
      leftDelta: Math.abs(listBox.left - composerBox.left),
      rowWidthRatio: rowBox.width / composerBox.width,
      steerInsideRow: row.contains(steer),
      steerNearRowEnd: rowBox.right - steerBox.right < 36,
      steerAligned: Math.abs((steerBox.top + steerBox.height / 2) - (rowBox.top + rowBox.height / 2)) <= 2,
      composerTop: composerBox.top,
      listBottom: listBox.bottom
    }
  })
  check('each queued row owns an inline steer action at its end', pendingLayout && !pendingLayout.insideComposer && pendingLayout.aboveComposer && pendingLayout.leftDelta <= 4 && pendingLayout.rowWidthRatio >= 0.95 && pendingLayout.steerInsideRow && pendingLayout.steerNearRowEnd && pendingLayout.steerAligned, pendingLayout)

  await waitFor(async () => (await page.locator('[data-run-action="stop"]').count()) === 1, 10_000, 'stop action after queued draft clears')
  await textarea.fill('STEER_CURRENT_7781')
  check('typing another follow-up exposes the composer queue action', await page.locator('[data-run-action="queue"]').count() === 1 && await page.locator('[data-run-action="stop"]').count() === 0)
  await textarea.press('Enter')
  await waitFor(async () => (await page.locator('[data-pending-message]').count()) === 2 && (await page.locator('[data-steer-pending]').count()) === 2, 10_000, 'two queued rows with inline steer actions')
  await page.getByRole('button', { name: /拒绝|Deny/ }).click()
  await page.waitForFunction(() => !document.querySelector('[data-testid="window-approval-overlay"]'), undefined, { timeout: 10_000 })
  await page.waitForFunction(() => document.querySelector('[data-run-status]')?.getAttribute('data-run-status') === 'waiting-model', undefined, { timeout: 10_000 })
  check('tool completion keeps a visible waiting-model status', await page.locator('[data-run-status="waiting-model"]').count() === 1)

  const steerRow = page.locator('[data-pending-message]').filter({ hasText: 'STEER_CURRENT_7781' })
  await steerRow.locator('[data-steer-pending]').click()
  await waitFor(async () => {
    const promoted = page.locator('[data-pending-message]').filter({ hasText: 'STEER_CURRENT_7781' })
    const ordinary = page.locator('[data-pending-message]').filter({ hasText: 'QUEUE_FOLLOWUP_7781' })
    return (await promoted.count()) === 1 && (await promoted.locator('[data-steer-pending]').count()) === 0 && (await promoted.innerText()).includes('等待引导') && (await ordinary.locator('[data-steer-pending]').count()) === 1
  }, 10_000, 'selected queued row promoted to steer')
  check('promoting one row preserves inline steer on the other queued rows', await page.locator('[data-steer-pending]').count() === 1)
  await screenshot(page, 'queue-and-steer-pending')

  await waitFor(async () => (await page.locator('body').innerText()).includes('STEER_CURRENT_APPLIED_7781'), 30_000, 'steer applied in current run')
  check('steer is applied before the queued follow-up starts', !(await page.locator('body').innerText()).includes('QUEUE_FOLLOWUP_APPLIED_7781'))

  await waitFor(async () => {
    const body = await page.locator('body').innerText()
    return body.includes('QUEUE_FOLLOWUP_APPLIED_7781') && await page.locator('[data-run-status]').count() > 0
  }, 40_000, 'automatically adopted queued run')
  check('automatically drained run exposes a live run status', await page.locator('[data-run-status]').count() === 1, await page.locator('[data-run-status]').getAttribute('data-run-status'))

  await page.waitForFunction(() => !document.querySelector('[data-run-status]'), undefined, { timeout: 40_000 })
  await waitFor(async () => (await page.locator('[data-pending-message]').count()) === 0, 10_000, 'pending queue to drain')
  const body = await page.locator('body').innerText()
  check('current-run steer response remains visible', body.includes('STEER_CURRENT_APPLIED_7781'))
  check('queued follow-up response remains visible', body.includes('QUEUE_FOLLOWUP_APPLIED_7781'))

  const sessionFiles = (await readdir(join(home, '.joker', 'sessions'))).filter((name) => name.endsWith('.json'))
  check('queue steer smoke persisted exactly one session', sessionFiles.length === 1, sessionFiles)
  const sessionEnvelope = JSON.parse(await readFile(join(home, '.joker', 'sessions', sessionFiles[0]), 'utf8'))
  const messages = sessionEnvelope.data.messages
  const contentOrder = messages.map((message) => message.content).filter(Boolean)
  const baseIndex = contentOrder.indexOf('QUEUE_STEER_BASE_7781')
  const steerIndex = contentOrder.indexOf('STEER_CURRENT_7781')
  const steerReplyIndex = contentOrder.indexOf('STEER_CURRENT_APPLIED_7781')
  const queueIndex = contentOrder.indexOf('QUEUE_FOLLOWUP_7781')
  const queueReplyIndex = contentOrder.indexOf('QUEUE_FOLLOWUP_APPLIED_7781')
  check(
    'durable transcript preserves tool-step steer and FIFO follow-up order',
    baseIndex >= 0 && steerIndex > baseIndex && steerReplyIndex > steerIndex && queueIndex > steerReplyIndex && queueReplyIndex > queueIndex,
    contentOrder
  )
  check('every queued or steered user message is persisted exactly once', contentOrder.filter((value) => value === 'STEER_CURRENT_7781').length === 1 && contentOrder.filter((value) => value === 'QUEUE_FOLLOWUP_7781').length === 1, contentOrder)
  check('durable pending queue is empty after both runs', sessionEnvelope.data.pendingUserMessages.length === 0, sessionEnvelope.data.pendingUserMessages)
  check('renderer has no relevant console errors', consoleErrors.length === 0, consoleErrors)
  check('renderer has no page errors', pageErrors.length === 0, pageErrors)
  await screenshot(page, 'queue-steer-complete')
} catch (error) {
  failure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) }
  try {
    const page = browser?.contexts()?.[0]?.pages()?.[0]
    if (page) await screenshot(page, 'queue-steer-failure')
  } catch { /* best effort */ }
} finally {
  if (browser) await browser.close().catch(() => undefined)
  await stopProcess(electron)
  await stopProcess(provider)
  const report = {
    generatedAt: new Date().toISOString(),
    runDir,
    checks,
    screenshots,
    failure,
    consoleErrors,
    pageErrors,
    providerOutput,
    electronOutput,
    providerLog: await providerEntries()
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ reportPath, runDir, checks, screenshots, failure }, null, 2))
  if (failure || checks.some((item) => !item.pass)) process.exitCode = 1
}
