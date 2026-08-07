import { chromium } from 'playwright-core'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { once } from 'node:events'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const runDir = await mkdtemp(join(tmpdir(), 'joker-electron-multi-session-'))
const home = join(runDir, 'home')
const electronUserData = join(runDir, 'electron-user-data')
const providerLogPath = join(runDir, 'fake-provider.log')
const reportPath = join(runDir, 'report.json')
const providerPort = 22800 + Math.floor(Math.random() * 400)
const cdpPort = 23300 + Math.floor(Math.random() * 400)
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
  if (!result.pass) throw new Error(`Electron multi-session concurrency smoke failed: ${name}`)
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
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
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
    await Promise.race([once(child, 'exit'), new Promise((resolveWait) => setTimeout(resolveWait, 5_000))])
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

function sessionRow(page, sessionId) {
  return page.locator(`[data-session-id="${sessionId}"]`)
}

async function selectSession(page, sessionId) {
  const row = sessionRow(page, sessionId)
  await row.locator('button').first().click()
  await waitFor(async () => await row.locator('button').first().getAttribute('aria-current') === 'page', 10_000, `session ${sessionId} selection`)
}

async function summaries(page) {
  return page.evaluate(() => window.joker.session.listSummaries())
}

async function summaryFor(page, sessionId) {
  return (await summaries(page)).find((summary) => summary.id === sessionId)
}

async function pendingApprovals(page) {
  return page.evaluate(() => window.joker.approval.listPending())
}

async function sendPrompt(page, prompt) {
  const textarea = page.locator('textarea').first()
  await textarea.fill(prompt)
  await textarea.press('Enter')
}

try {
  provider = spawn(process.execPath, [join(root, 'scripts', 'fixtures', 'fake-provider.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(providerPort),
      LOG_PATH: providerLogPath,
      JOKER_FAKE_SCENARIO: 'multi-session',
      JOKER_FAKE_STREAM_DELAY_MS: '150',
      JOKER_FAKE_NEXT_STEP_DELAY_MS: '3500'
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
      name: 'QA Multi-session Provider',
      type: 'openai-compatible',
      apiFormat: 'chat-completions',
      baseUrl: `http://127.0.0.1:${providerPort}/v1`,
      apiKey: 'qa-multi-session-key',
      models: [{ id: 'gpt-4o', name: 'gpt-4o', enabled: true, maxContextTokens: 262144 }],
      currentModelId: 'gpt-4o',
      enabled: true,
      promptCache: false
    }],
    activeProviderId: 'qa-provider',
    mcpServers: [],
    disabledSkills: [],
    approvalMode: 'suggest'
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
    let timer
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
    timer = setTimeout(() => finish(reject, new Error(`Electron did not expose CDP endpoint: ${electronOutput.join('')}`)), 20_000)
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
  await page.waitForFunction(() => Boolean(window.joker?.session?.listSummaries))
  await page.waitForSelector('textarea')
  await waitFor(async () => (await summaries(page)).length === 1, 20_000, 'initial session')
  await page.evaluate(() => {
    window.__jokerMultiSessionQa = { approvals: [], summaryEvents: [] }
    window.joker.approval.onRequest((request) => window.__jokerMultiSessionQa.approvals.push(request))
    window.joker.session.onSummaryChanged((event) => window.__jokerMultiSessionQa.summaryEvents.push(event))
  })

  const sessionA = (await summaries(page))[0]
  check('initial session A exists', Boolean(sessionA?.id), sessionA)
  await page.evaluate((sessionId) => window.joker.session.rename(sessionId, 'Session A'), sessionA.id)
  await page.getByRole('button', { name: /新建对话|New chat/i }).click()
  await waitFor(async () => (await summaries(page)).length === 2, 10_000, 'second session')
  const sessionB = (await summaries(page)).find((session) => session.id !== sessionA.id)
  check('session B is distinct from session A', Boolean(sessionB?.id && sessionB.id !== sessionA.id), { sessionA: sessionA.id, sessionB: sessionB?.id })
  await page.evaluate((sessionId) => window.joker.session.rename(sessionId, 'Session B'), sessionB.id)
  await sendPrompt(page, 'MULTI_SESSION_B_7781')
  await waitFor(async () => (await pendingApprovals(page)).some((approval) => approval.sessionId === sessionB.id), 20_000, 'session B approval')
  const approvalB = (await pendingApprovals(page)).find((approval) => approval.sessionId === sessionB.id)
  check('session B approval is scoped to B and its run', approvalB?.sessionId === sessionB.id && Boolean(approvalB.runId) && approvalB.toolName === 'Write', approvalB)
  check('active B approval UI contains only B tool input', (await page.locator('body').innerText()).includes('multi-session-b.txt') && !(await page.locator('body').innerText()).includes('multi-session-a.txt'))

  await page.getByTestId('window-approval-overlay').getByRole('button', { name: /拒绝|Deny/i }).click()
  await waitFor(async () => !(await pendingApprovals(page)).some((approval) => approval.sessionId === sessionB.id), 10_000, 'initial B approval denial')
  check('denying B clears its modal before switching sessions', await page.getByTestId('window-approval-overlay').count() === 0)

  await selectSession(page, sessionA.id)
  check('switching to A leaves no stale B approval UI', !(await page.locator('body').innerText()).includes('multi-session-b.txt'))
  await sendPrompt(page, 'MULTI_SESSION_A_7781')
  await waitFor(async () => (await pendingApprovals(page)).some((approval) => approval.sessionId === sessionA.id), 20_000, 'session A approval')
  const approvals = await pendingApprovals(page)
  const approvalA = approvals.find((approval) => approval.sessionId === sessionA.id)
  check('session A approval is scoped to A and its run', approvalA?.sessionId === sessionA.id && Boolean(approvalA.runId) && approvalA.toolName === 'Write', approvalA)
  check('resolved B approval does not leak into A approval state', approvals.length === 1 && approvals[0]?.requestId === approvalA?.requestId, approvals)
  check('active A approval UI contains only A tool input', (await page.locator('body').innerText()).includes('multi-session-a.txt') && !(await page.locator('body').innerText()).includes('multi-session-b.txt'))
  const overlappingSummaries = await summaries(page)
  const overlappingA = overlappingSummaries.find((summary) => summary.id === sessionA.id)
  const overlappingB = overlappingSummaries.find((summary) => summary.id === sessionB.id)
  check('authoritative summaries isolate A awaiting-user from B background execution', overlappingA?.activity.status === 'awaiting-user' && overlappingB?.activity.status !== 'awaiting-user' && overlappingA.activity.pendingApprovalCount === 1 && overlappingB.activity.pendingApprovalCount === 0, overlappingSummaries)
  await page.locator('[data-detail-run-duration]').waitFor({ state: 'visible', timeout: 10_000 })
  const initialDuration = await page.locator('[data-detail-run-duration]').innerText()
  await page.waitForTimeout(1_100)
  const advancedDuration = await page.locator('[data-detail-run-duration]').innerText()
  check('active feedback shows a live elapsed duration', /^\d{2}:\d{2}$|^\d+:\d{2}:\d{2}$/.test(initialDuration) && advancedDuration !== initialDuration, { initialDuration, advancedDuration })
  await screenshot(page, 'overlapping-session-approvals')

  await page.getByTestId('window-approval-overlay').getByRole('button', { name: /拒绝|Deny/i }).click()
  await waitFor(async () => (await pendingApprovals(page)).length === 0, 10_000, 'A approval denial before cancellation')
  await page.locator('[data-run-action="stop"]').click()
  await waitFor(async () => (await summaryFor(page, sessionA.id))?.activity.status === 'cancelled', 20_000, 'session A cancellation')
  await waitFor(async () => (await pendingApprovals(page)).length === 0, 10_000, 'all approvals resolved after A stop')
  check('Stop A does not reintroduce resolved B approval', (await pendingApprovals(page)).length === 0, await pendingApprovals(page))
  await waitFor(async () => await sessionRow(page, sessionB.id).getAttribute('data-session-status') !== 'awaiting-user', 10_000, 'background B leaves awaiting-user state')
  check('sidebar keeps B out of awaiting approval after denial', await sessionRow(page, sessionB.id).getAttribute('data-session-status') !== 'awaiting-user')

  await selectSession(page, sessionB.id)
  const bodyOnB = await page.locator('body').innerText()
  check('switching back to B excludes A approval UI', !bodyOnB.includes('multi-session-a.txt'))
  await waitFor(async () => {
    const status = await page.locator('[data-detail-run-status]').getAttribute('data-detail-run-status')
    return status === 'waiting-model' || status === 'idle'
  }, 10_000, 'B provider continuation after initial denial')
  await selectSession(page, sessionA.id)
  await waitFor(async () => {
    const summary = await summaryFor(page, sessionB.id)
    return summary?.activity.status === 'completed' && summary.activity.unread
  }, 30_000, 'background B completion')
  await waitFor(async () => await sessionRow(page, sessionB.id).getAttribute('data-session-status') === 'completed', 10_000, 'background B completed icon')
  check('background completion is represented by the completed sidebar icon state', await sessionRow(page, sessionB.id).getAttribute('data-session-status') === 'completed')
  const firstCompletion = await summaryFor(page, sessionB.id)
  check('first B completion advances an unread terminal revision', firstCompletion.activity.terminalRevision > 0 && firstCompletion.activity.seenTerminalRevision < firstCompletion.activity.terminalRevision && firstCompletion.activity.unread, firstCompletion.activity)
  await screenshot(page, 'background-b-completed')

  const firstRevision = firstCompletion.activity.terminalRevision
  const markedFirst = await page.evaluate(({ sessionId, revision }) => window.joker.session.markSeen(sessionId, revision), { sessionId: sessionB.id, revision: firstRevision })
  check('markSeen acknowledges exactly the observed B terminal revision', markedFirst?.activity.seenTerminalRevision === firstRevision && markedFirst.activity.unread === false, markedFirst?.activity)
  await waitFor(async () => {
    const events = await page.evaluate(() => window.__jokerMultiSessionQa.summaryEvents)
    return events.some((event) => event.type === 'upsert' && event.sessionId === sessionB.id && event.summary?.activity.seenTerminalRevision === firstRevision && event.summary?.activity.unread === false)
  }, 10_000, 'markSeen summary revision event')
  check('markSeen emits an authoritative summary update', true)

  await selectSession(page, sessionB.id)
  await sendPrompt(page, 'MULTI_SESSION_STOP_B_7781')
  await waitFor(async () => (await pendingApprovals(page)).some((approval) => approval.sessionId === sessionB.id), 20_000, 'second B approval')
  check('a later B run does not revive A approval', (await pendingApprovals(page)).every((approval) => approval.sessionId === sessionB.id), await pendingApprovals(page))
  await page.getByRole('button', { name: /拒绝|Deny/i }).click()
  await waitFor(async () => await page.locator('[data-detail-run-status]').getAttribute('data-detail-run-status') === 'waiting-model', 10_000, 'second B provider continuation')
  await selectSession(page, sessionA.id)
  await waitFor(async () => {
    const summary = await summaryFor(page, sessionB.id)
    return summary?.activity.status === 'completed' && summary.activity.terminalRevision > firstRevision
  }, 30_000, 'second background B completion')
  const secondCompletion = await summaryFor(page, sessionB.id)
  check('later completion creates a new unread revision', secondCompletion.activity.terminalRevision > firstRevision && secondCompletion.activity.seenTerminalRevision === firstRevision && secondCompletion.activity.unread, secondCompletion.activity)
  const staleSeen = await page.evaluate(({ sessionId, revision }) => window.joker.session.markSeen(sessionId, revision), { sessionId: sessionB.id, revision: firstRevision })
  check('stale seen acknowledgement cannot hide a newer completion', staleSeen?.activity.terminalRevision === secondCompletion.activity.terminalRevision && staleSeen.activity.seenTerminalRevision === firstRevision && staleSeen.activity.unread, staleSeen?.activity)
  const currentSeen = await page.evaluate(({ sessionId, revision }) => window.joker.session.markSeen(sessionId, revision), { sessionId: sessionB.id, revision: secondCompletion.activity.terminalRevision })
  check('current seen acknowledgement clears only the observed revision', currentSeen?.activity.seenTerminalRevision === secondCompletion.activity.terminalRevision && currentSeen.activity.unread === false, currentSeen?.activity)

  await selectSession(page, sessionB.id)
  await waitFor(async () => (await page.locator('body').innerText()).includes('MULTI_SESSION_B_COMPLETED_7781'), 10_000, 'persisted B transcript render')
  const visibleB = await page.locator('body').innerText()
  check('session B renders its own durable replies after switching back', visibleB.includes('MULTI_SESSION_B_COMPLETED_7781') && visibleB.includes('MULTI_SESSION_STOP_B_COMPLETED_7781'))
  check('session B renderer excludes session A prompt', !visibleB.includes('MULTI_SESSION_A_7781'))

  const stored = await page.evaluate(async ({ sessionAId, sessionBId }) => ({
    sessionA: await window.joker.session.get(sessionAId),
    sessionB: await window.joker.session.get(sessionBId)
  }), { sessionAId: sessionA.id, sessionBId: sessionB.id })
  const aContents = stored.sessionA?.messages.map((message) => String(message.content ?? '')) ?? []
  const bContents = stored.sessionB?.messages.map((message) => String(message.content ?? '')) ?? []
  check('durable session A transcript contains A exactly once and no B markers', aContents.filter((content) => content === 'MULTI_SESSION_A_7781').length === 1 && !aContents.some((content) => content.includes('MULTI_SESSION_B_7781') || content.includes('MULTI_SESSION_STOP_B_7781')), aContents)
  check('durable session B transcript contains both B turns exactly once and no A marker', bContents.filter((content) => content === 'MULTI_SESSION_B_7781').length === 1 && bContents.filter((content) => content === 'MULTI_SESSION_STOP_B_7781').length === 1 && !bContents.some((content) => content.includes('MULTI_SESSION_A_7781')), bContents)
  check('durable session B transcript preserves both isolated completions', bContents.includes('MULTI_SESSION_B_COMPLETED_7781') && bContents.includes('MULTI_SESSION_STOP_B_COMPLETED_7781'), bContents)

  const sessionDir = join(home, '.joker', 'sessions')
  const sessionFiles = (await readdir(sessionDir)).filter((name) => name.endsWith('.json'))
  check('same-window smoke persisted exactly the two exercised sessions', sessionFiles.length === 2 && sessionFiles.includes(`${sessionA.id}.json`) && sessionFiles.includes(`${sessionB.id}.json`), sessionFiles)
  const [diskA, diskB] = await Promise.all([
    readFile(join(sessionDir, `${sessionA.id}.json`), 'utf8').then(JSON.parse),
    readFile(join(sessionDir, `${sessionB.id}.json`), 'utf8').then(JSON.parse)
  ])
  check('on-disk envelopes retain isolated transcript ownership', diskA.data.id === sessionA.id && diskB.data.id === sessionB.id && !JSON.stringify(diskA.data.messages).includes('MULTI_SESSION_B_7781') && !JSON.stringify(diskB.data.messages).includes('MULTI_SESSION_A_7781'))

  const requestLog = await providerEntries()
  const chatRequests = requestLog.filter((entry) => entry.method === 'POST' && entry.url === '/v1/chat/completions')
  check('fake provider observed both session conversations independently', chatRequests.some((entry) => entry.body?.messages?.some((message) => String(message.content ?? '').includes('MULTI_SESSION_A_7781'))) && chatRequests.some((entry) => entry.body?.messages?.some((message) => String(message.content ?? '').includes('MULTI_SESSION_B_7781'))), chatRequests.length)
  check('renderer has no relevant console errors', consoleErrors.length === 0, consoleErrors)
  check('renderer has no page errors', pageErrors.length === 0, pageErrors)
  await screenshot(page, 'multi-session-complete')
} catch (error) {
  failure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) }
  try {
    const page = browser?.contexts()?.[0]?.pages()?.[0]
    if (page) await screenshot(page, 'multi-session-failure')
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
