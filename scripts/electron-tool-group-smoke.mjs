import { chromium } from 'playwright-core'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { once } from 'node:events'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const runDir = await mkdtemp(join(tmpdir(), 'joker-electron-tool-group-'))
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
  if (!result.pass) throw new Error(`Electron tool group smoke failed: ${name}`)
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

async function lifecycleSnapshot(page) {
  return page.evaluate(() => {
    const groups = [...document.querySelectorAll('[data-tool-call-group]')]
    const chatGroup = groups.find((group) => !group.closest('aside'))
    const detailGroup = groups.find((group) => Boolean(group.closest('aside')))
    const snapshot = (group) => {
      const toggle = group?.querySelector('[data-tool-call-group-toggle]')
      return group && toggle
        ? { expanded: toggle.getAttribute('aria-expanded'), text: group.textContent ?? '' }
        : null
    }
    return { chat: snapshot(chatGroup), detail: snapshot(detailGroup), count: groups.length }
  })
}

try {
  provider = spawn(process.execPath, [join(root, 'scripts', 'fixtures', 'fake-provider.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(providerPort),
      LOG_PATH: providerLogPath,
      JOKER_FAKE_SCENARIO: 'tool-lifecycle',
      JOKER_FAKE_STREAM_DELAY_MS: '700'
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
      name: 'QA Tool Lifecycle Provider',
      type: 'openai-compatible',
      apiFormat: 'chat-completions',
      baseUrl: `http://127.0.0.1:${providerPort}/v1`,
      apiKey: 'qa-tool-key',
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
  await textarea.fill('Run the deterministic tool lifecycle smoke.')
  await textarea.press('Enter')
  await page.waitForFunction(() => document.querySelector('textarea')?.disabled === false && Boolean(document.querySelector('[data-run-status]')), undefined, { timeout: 10_000 })

  await waitFor(async () => {
    const snapshot = await lifecycleSnapshot(page)
    return snapshot.chat?.text.includes('2') && snapshot.detail?.text.includes('2')
  }, 30_000, 'two-tool groups in chat and detail')
  const initial = await lifecycleSnapshot(page)
  check('multi-tool groups default collapsed in chat and detail', initial.chat?.expanded === 'false' && initial.detail?.expanded === 'false', initial)

  const chatToggle = page.locator('[data-tool-call-group]:not(aside [data-tool-call-group]) [data-tool-call-group-toggle]').first()
  const detailToggle = page.locator('aside [data-tool-call-group-toggle]').first()
  await chatToggle.click()
  await detailToggle.click()
  check('manual click expands both tool groups', await chatToggle.getAttribute('aria-expanded') === 'true' && await detailToggle.getAttribute('aria-expanded') === 'true')

  await waitFor(async () => {
    const snapshot = await lifecycleSnapshot(page)
    return snapshot.chat?.text.includes('3') && snapshot.detail?.text.includes('3')
  }, 30_000, 'third tool appended')
  const afterAppend = await lifecycleSnapshot(page)
  check('new tool does not override manual expanded state', afterAppend.chat?.expanded === 'true' && afterAppend.detail?.expanded === 'true', afterAppend)

  await chatToggle.click()
  await detailToggle.click()
  check('manual click collapses both tool groups', await chatToggle.getAttribute('aria-expanded') === 'false' && await detailToggle.getAttribute('aria-expanded') === 'false')

  await page.waitForFunction(() => !document.querySelector('[data-run-status]'), undefined, { timeout: 60_000 })
  await waitFor(async () => {
    const snapshot = await lifecycleSnapshot(page)
    return snapshot.chat?.text.includes('3') && snapshot.chat.expanded === 'false'
  }, 20_000, 'persisted collapsed three-tool group')
  const completed = await lifecycleSnapshot(page)
  check(
    'completed step tools remain visible and collapsed in chat',
    completed.chat?.expanded === 'false' &&
      completed.chat.text.includes('3') &&
      completed.chat.text.includes('读取') &&
      completed.chat.text.includes('Git 状态') &&
      completed.chat.text.includes('Git 日志'),
    completed
  )
  const sessionFiles = (await readdir(join(home, '.joker', 'sessions'))).filter((name) => name.endsWith('.json'))
  check('tool lifecycle persisted exactly one session file', sessionFiles.length === 1, sessionFiles)
  const sessionEnvelope = JSON.parse(await readFile(join(home, '.joker', 'sessions', sessionFiles[0]), 'utf8'))
  const persistedTools = sessionEnvelope.data.messages.flatMap((message) => message.toolCalls ?? [])
  check(
    'persisted session retains every completed lifecycle tool',
    persistedTools.length === 3 &&
      persistedTools.map((tool) => tool.toolCallId).join(',') === 'call_lifecycle_first,call_lifecycle_second,call_lifecycle_third' &&
      persistedTools.every((tool) => tool.status === 'done' || tool.status === 'error'),
    persistedTools
  )
  check('completed tools leave the pending-only detail panel', completed.detail === null, completed)
  check('renderer has no relevant console errors', consoleErrors.length === 0, consoleErrors)
  check('renderer has no page errors', pageErrors.length === 0, pageErrors)
  await screenshot(page, 'tool-group-complete')
} catch (error) {
  failure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) }
  try {
    const page = browser?.contexts()?.[0]?.pages()?.[0]
    if (page) await screenshot(page, 'tool-group-failure')
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
    electronOutput
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ reportPath, runDir, checks, screenshots, failure }, null, 2))
  if (failure || checks.some((item) => !item.pass)) process.exitCode = 1
}
