// Real-chain verification for the token ledger + sidebar grouping/search slice.
// Rides the same fake-provider + real Electron pattern as electron-ui-slice-smoke.
// Phase A: send a chat -> DetailPanel token ledger shows provider-measured usage
//          (input/cache split, session cumulative, TTFT, tok/s).
// Phase B: sidebar groups sessions by bound project and filters by title search.
import { chromium } from 'playwright-core'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { once } from 'node:events'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const runDir = await mkdtemp(join(tmpdir(), 'joker-electron-ui-ab-'))
const home = join(runDir, 'home')
const logPath = join(runDir, 'fake-provider.log')
const reportPath = join(runDir, 'report.json')
const providerPort = 27200 + Math.floor(Math.random() * 400)
const cdpPort = 27700 + Math.floor(Math.random() * 400)
const checks = []
const screenshots = []
const consoleErrors = []
const pageErrors = []

function check(name, value, details = undefined) {
  const result = { name, pass: Boolean(value), ...(details === undefined ? {} : { details }) }
  checks.push(result)
  if (!result.pass) throw new Error(`UI A+B smoke failed: ${name}`)
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
    env: { ...process.env, PORT: String(providerPort), LOG_PATH: logPath },
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

  const projectA = join(runDir, 'project-a')
  const projectB = join(runDir, 'project-b')
  await mkdir(join(home, '.joker'), { recursive: true })
  await mkdir(projectA, { recursive: true })
  await mkdir(projectB, { recursive: true })
  await writeFile(join(projectA, 'package.json'), JSON.stringify({ name: 'project-a', private: true }), 'utf8')
  await writeFile(join(projectB, 'package.json'), JSON.stringify({ name: 'project-b', private: true }), 'utf8')
  await writeFile(join(home, '.joker', 'config.json'), JSON.stringify({
    providers: [{
      id: 'qa-provider',
      name: 'QA Ledger Provider',
      type: 'openai-compatible',
      apiFormat: 'chat-completions',
      baseUrl: `http://127.0.0.1:${providerPort}/v1`,
      apiKey: 'qa-ledger-key',
      models: [{ id: 'gpt-4o', name: 'gpt-4o', enabled: true }],
      currentModelId: 'gpt-4o',
      enabled: true
    }],
    activeProviderId: 'qa-provider',
    mcpServers: [],
    approvalMode: 'suggest'
  }, null, 2))
  await writeFile(join(home, '.joker', 'projects.json'), JSON.stringify({
    projects: [
      { id: 'proj-alpha', name: 'Alpha Repo', path: projectA, lastUsedAt: Date.now() },
      { id: 'proj-beta', name: 'Beta Repo', path: projectB, lastUsedAt: Date.now() - 1000 }
    ],
    activeProjectId: 'proj-alpha'
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
  // Wait for the renderer to boot and render its initial sidebar session list.
  await page.waitForSelector('[data-session-id]', { timeout: 30_000 })

  // ---- Phase B setup: create two sessions, each bound to a different project.
  const alphaSessionId = await page.evaluate(() => window.joker.session.create('Ledger QA Alpha 会话').then((session) => session.id))
  check('initial session exists for binding', Boolean(alphaSessionId))
  const boundA = await page.evaluate(({ sessionId }) => window.joker.session.setProject(sessionId, 'proj-alpha'), { sessionId: alphaSessionId })
  check('session bound to Alpha Repo', Boolean(boundA))
  const betaSessionId = await page.evaluate(() => window.joker.session.create('Unrelated beta chat').then((session) => session.id))
  const boundB = await page.evaluate(({ sessionId }) => window.joker.session.setProject(sessionId, 'proj-beta'), { sessionId: betaSessionId })
  check('second session bound to Beta Repo', Boolean(boundB))
  await page.waitForSelector(`[data-session-id="${alphaSessionId}"]`, { timeout: 30_000 })
  await page.click(`[data-session-id="${alphaSessionId}"] button`)
  // loadSession is asynchronous; wait until the session has fully loaded before sending.
  await page.waitForTimeout(1_500)
  await page.waitForFunction(() => !document.body.innerText.includes('会话仍在加载') && !document.body.innerText.includes('conversation is still loading'), undefined, { timeout: 30_000 })

  // ---- Phase A: send a message, wait for reply, inspect the token ledger.
  await page.waitForSelector('textarea', { timeout: 30_000 })
  await page.waitForFunction(() => {
    const textarea = document.querySelector('textarea')
    return Boolean(textarea && !textarea.disabled)
  }, undefined, { timeout: 30_000 })
  const textarea = page.locator('textarea').first()
  await textarea.fill('token ledger probe')
  await textarea.press('Enter')
  try {
    await page.waitForFunction(() => document.body.innerText.includes('Fake Provider is online.'), undefined, { timeout: 60_000 })
  } catch (error) {
    const bodyText = await page.evaluate(() => document.body.innerText)
    throw new Error(`Reply never arrived. Body excerpt: ${bodyText.slice(0, 1500)}`)
  }

  const ledger = page.locator('[data-token-ledger]')
  try {
    await ledger.waitFor({ state: 'visible', timeout: 10_000 })
  } catch (error) {
    const detailText = await page.evaluate(() => document.body.innerText)
    throw new Error(`Token ledger never became visible. Body excerpt: ${detailText.slice(0, 1800)}`)
  }
  const ledgerText = await ledger.innerText()
  check('ledger shows the two-column header (last run + session)', /本次|Last/.test(ledgerText) && /会话累计|Session/.test(ledgerText), ledgerText)
  check('ledger shows provider-measured input tokens', /520/.test(ledgerText), ledgerText)
  check('ledger shows the cache split (cached 300)', /300/.test(ledgerText), ledgerText)
  check('ledger shows output tokens', /28/.test(ledgerText), ledgerText)
  check('ledger shows the run counter', /1\s*次运行|1\s*runs/.test(ledgerText), ledgerText)
  const ttftCell = await ledger.locator('span', { hasText: /ms|s/ }).filter({ hasText: /^\d+(\.\d+)?(ms|s)$/ }).count()
  check('ledger renders TTFT and throughput values', ttftCell >= 2, { ttftCell })
  await page.screenshot({ path: join(runDir, 'token-ledger.png') })
  screenshots.push(join(runDir, 'token-ledger.png'))

  // ---- Phase B: sidebar grouping.
  await page.waitForFunction(() => document.querySelectorAll('[data-session-group]').length >= 2, undefined, { timeout: 10_000 })
  const groups = await page.evaluate(() => [...document.querySelectorAll('[data-session-group]')].map((element) => ({
    key: element.getAttribute('data-session-group'),
    text: element.innerText
  })))
  const alphaGroup = groups.find((group) => /alpha repo/i.test(group.text))
  const betaGroup = groups.find((group) => /beta repo/i.test(group.text))
  check('sidebar groups sessions under project headers', Boolean(alphaGroup && betaGroup), groups.map((group) => group.text))
  check('alpha group holds the alpha session only', Boolean(alphaGroup?.text.includes('Ledger QA Alpha 会话') && !alphaGroup?.text.includes('Unrelated beta chat')), alphaGroup?.text)
  check('beta group holds the beta session only', Boolean(betaGroup?.text.includes('Unrelated beta chat') && !betaGroup?.text.includes('Ledger QA Alpha 会话')), betaGroup?.text)
  check('alpha group holds the alpha session only', Boolean(alphaGroup?.text.includes('Ledger QA Alpha 会话') && !alphaGroup?.text.includes('Unrelated beta chat')), alphaGroup?.text)
  check('beta group holds the beta session only', Boolean(betaGroup?.text.includes('Unrelated beta chat') && !betaGroup?.text.includes('Ledger QA Alpha 会话')), betaGroup?.text)

  // Collapse behavior.
  const alphaHeader = page.locator('[data-session-group] button').filter({ hasText: /alpha repo/i }).first()
  await alphaHeader.click()
  const collapsedText = await page.evaluate(() => document.querySelector('[data-session-group]')?.parentElement?.innerText ?? '')
  check('collapsing a project group hides its sessions', !collapsedText.includes('Ledger QA Alpha 会话'), collapsedText)
  await alphaHeader.click()

  // Search filtering.
  const searchBox = page.locator('[data-session-search]')
  await searchBox.fill('Ledger QA')
  await page.waitForTimeout(200)
  const searchText = await page.evaluate(() => document.querySelectorAll('[data-session-id]').length)
  check('search filters sessions by title', searchText === 1, { visibleSessions: searchText })
  const noResultShown = await page.evaluate(() => document.body.innerText.includes('没有匹配的会话') || document.body.innerText.includes('No matching conversations'))
  await searchBox.fill('zzz-no-such-session')
  await page.waitForTimeout(200)
  const noResultsNow = await page.evaluate(() => document.body.innerText.includes('没有匹配的会话') || document.body.innerText.includes('No matching conversations'))
  check('empty search result shows the no-results hint', !noResultShown && noResultsNow)
  await page.screenshot({ path: join(runDir, 'sidebar-grouped-search.png') })
  screenshots.push(join(runDir, 'sidebar-grouped-search.png'))

  // Provider actually reported the usage the ledger displays.
  const requests = (await readFile(logPath, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  const chatRequests = requests.filter((entry) => entry.body?.stream === true)
  check('fake provider served the streaming chat request', chatRequests.length >= 1, { count: chatRequests.length })

  check('ui A+B leaves no renderer console errors', consoleErrors.length === 0, consoleErrors)
  check('ui A+B leaves no renderer page errors', pageErrors.length === 0, pageErrors)
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
