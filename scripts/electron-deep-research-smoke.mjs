import { chromium } from 'playwright-core'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { once } from 'node:events'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const runDir = await mkdtemp(join(tmpdir(), 'joker-electron-deep-research-'))
const home = join(runDir, 'home')
const electronUserData = join(runDir, 'electron-user-data')
const providerLogPath = join(runDir, 'fake-provider.log')
const reportPath = join(runDir, 'report.json')
const providerPort = 20765 + Math.floor(Math.random() * 500)
const cdpPortBase = 21300 + Math.floor(Math.random() * 400)
const reportTitle = 'Example Domain Deterministic Research Report'
const checks = []
const screenshots = []
const consoleEvents = []
const ignoredConsoleEvents = []
const pageErrors = []
const electronRuns = []
let failure = null
let failureDiagnostics = null
let electron
let browser
let provider
let providerOutput = []
let launchCount = 0

function check(name, value, details = undefined) {
  const result = { name, pass: Boolean(value), ...(details === undefined ? {} : { details }) }
  checks.push(result)
  if (!result.pass) throw new Error(`Electron deep research smoke failed: ${name}`)
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
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`Timed out waiting for ${description}${lastError instanceof Error ? `: ${lastError.message}` : ''}`)
}

async function screenshot(page, name, locator = null) {
  const path = join(runDir, `${name}.png`)
  if (locator) await locator.screenshot({ path })
  else await page.screenshot({ path })
  screenshots.push(path)
  return path
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

function parseProviderLog(text) {
  return text.split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

async function providerEntries() {
  try { return parseProviderLog(await readFile(providerLogPath, 'utf8')) } catch { return [] }
}

function toolNamesFromProviderEntry(entry) {
  return Array.isArray(entry?.body?.tools)
    ? entry.body.tools.map((tool) => tool?.function?.name).filter((name) => typeof name === 'string')
    : []
}

function messageToolNames(messages) {
  if (!Array.isArray(messages)) return []
  return messages.flatMap((message) => Array.isArray(message?.tool_calls)
    ? message.tool_calls.map((call) => call?.function?.name).filter((name) => typeof name === 'string')
    : [])
}

function flattenTools(session) {
  return (session?.messages ?? []).flatMap((message) => message?.segments?.flatMap((segment) => segment.type === 'tools' ? segment.tools : []) ?? message?.toolCalls ?? [])
}

function reportTool(session) {
  return flattenTools(session).find((tool) => tool.toolName === 'PresentResearchReport' && tool.metadata?.researchReport)
}

function classifyConsoleEvent(event) {
  const harmlessPatterns = [
    /ResizeObserver loop (limit exceeded|completed with undelivered notifications)/i,
    /Autofill\.enable/i,
    /script-src.*default-src.*fallback/i
  ]
  return harmlessPatterns.some((pattern) => pattern.test(event.text)) ? 'ignored' : 'relevant'
}

async function launchElectron(label) {
  const cdpPort = cdpPortBase + launchCount++
  const output = []
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
  const onData = (chunk) => output.push(String(chunk))
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
      const match = output.join('').match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (match) finish(resolveWs, match[1])
    }
    electron.stdout.on('data', inspect)
    electron.stderr.on('data', inspect)
    electron.once('error', (error) => finish(reject, error))
    electron.once('exit', (code, signal) => finish(reject, new Error(`Electron exited before CDP: code=${code} signal=${signal}; output=${output.join('')}`)))
    const timer = setTimeout(() => finish(reject, new Error(`Electron did not expose CDP endpoint: ${output.join('')}`)), 20_000)
    inspect()
  })
  browser = await chromium.connectOverCDP(ws)
  const context = browser.contexts()[0]
  await waitFor(() => context.pages().length > 0, 10_000, `${label} renderer page`)
  const page = context.pages()[0]
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const event = { launch: label, type: message.type(), text: message.text(), location: message.location() }
    if (classifyConsoleEvent(event) === 'ignored') ignoredConsoleEvents.push(event)
    else consoleEvents.push(event)
  })
  page.on('pageerror', (error) => pageErrors.push({ launch: label, name: error.name, message: error.message, stack: error.stack }))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.joker?.session?.list && window.joker?.approval?.onRequest))
  await waitFor(async () => (await page.evaluate(() => window.joker.session.list())).length > 0, 20_000, `${label} initial session`)
  electronRuns.push({ label, cdpPort, output })
  return page
}

async function activeSession(page) {
  const sessions = await page.evaluate(() => window.joker.session.list())
  return sessions[0] ? page.evaluate((id) => window.joker.session.get(id), sessions[0].id) : null
}

async function inspectRenderedReport(page) {
  const article = page.locator('article').filter({ hasText: reportTitle }).first()
  await article.waitFor({ state: 'visible', timeout: 20_000 })
  const articleText = await article.innerText()
  const headings = await article.locator('h3').allTextContents()
  const citation = article.getByRole('button', { name: /S1/ }).first()
  const canvas = article.locator('canvas').first()
  await canvas.waitFor({ state: 'visible', timeout: 20_000 })
  await waitFor(async () => canvas.evaluate((element) => element.width > 0 && element.height > 0 && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0), 10_000, 'non-zero ECharts canvas')
  const canvasMetrics = await canvas.evaluate((element) => ({
    width: element.width,
    height: element.height,
    clientWidth: element.getBoundingClientRect().width,
    clientHeight: element.getBoundingClientRect().height
  }))
  return { article, articleText, headings, citation, canvas, canvasMetrics }
}

try {
  provider = spawn(process.execPath, [join(root, 'scripts', 'fixtures', 'fake-provider.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(providerPort),
      LOG_PATH: providerLogPath,
      JOKER_FAKE_SCENARIO: 'research'
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
      name: 'QA Research Provider',
      type: 'openai-compatible',
      apiFormat: 'chat-completions',
      baseUrl: `http://127.0.0.1:${providerPort}/v1`,
      apiKey: 'qa-research-key',
      models: [{ id: 'gpt-4o', name: 'gpt-4o', enabled: true, maxContextTokens: 262144 }],
      currentModelId: 'gpt-4o',
      enabled: true,
      promptCache: false
    }],
    activeProviderId: 'qa-provider',
    mcpServers: [],
    disabledSkills: []
  }, null, 2))

  let page = await launchElectron('initial')
  await page.evaluate(() => {
    window.__jokerQaApprovalRequests = []
    window.joker.approval.onRequest((request) => window.__jokerQaApprovalRequests.push(request))
    window.joker.approval.setMode('suggest')
  })
  check('renderer booted with isolated fake provider', await page.locator('body').innerText().then((text) => text.includes('JOKER')))

  const researchMode = page.getByRole('radio', { name: /深度研究|Deep Research/i })
  await researchMode.click()
  check('InputBox selects Deep Research mode', await researchMode.getAttribute('aria-checked') === 'true')
  const textarea = page.locator('textarea').first()
  check('research placeholder is visible', await textarea.getAttribute('placeholder').then((value) => /研究|research/i.test(value ?? '')), { placeholder: await textarea.getAttribute('placeholder') })
  await textarea.fill('Deterministically research the public Example Domain page and present a cited report with a chart.')
  await textarea.press('Enter')
  await page.waitForFunction(() => document.querySelector('textarea')?.disabled === true, undefined, { timeout: 10_000 })
  await page.waitForFunction(() => Array.isArray(window.__jokerQaApprovalRequests) && window.__jokerQaApprovalRequests.length === 1, undefined, { timeout: 30_000 })
  const approval = await page.evaluate(() => window.__jokerQaApprovalRequests[0])
  check('one run-scoped ResearchWebAccess approval is requested', approval?.toolName === 'ResearchWebAccess' && Boolean(approval.sessionId && approval.runId), approval)
  check('approval input covers WebSearch and WebRead', JSON.stringify(approval?.input?.tools) === JSON.stringify(['WebSearch', 'WebRead']) && approval?.input?.firstCall?.toolName === 'WebSearch', approval?.input)
  check('approval input carries deterministic search query', approval?.input?.firstCall?.input?.query === 'Example Domain example.com', approval?.input?.firstCall)
  const approvalText = await page.locator('body').innerText()
  check('approval copy exposes 6-search and 12-read budgets', /6/.test(approvalText) && /12/.test(approvalText) && /搜索|search/i.test(approvalText) && /读取|read/i.test(approvalText), approvalText.slice(-1600))
  await screenshot(page, 'research-approval')
  await page.getByRole('button', { name: /允许|Allow/i }).click()

  await page.waitForFunction(() => document.querySelector('textarea')?.disabled === false, undefined, { timeout: 120_000 })
  await waitFor(async () => Boolean(reportTool(await activeSession(page))), 20_000, 'persisted research report metadata')
  const session = await activeSession(page)
  const tools = flattenTools(session)
  const search = tools.find((tool) => tool.toolName === 'WebSearch')
  const read = tools.find((tool) => tool.toolName === 'WebRead')
  const presentation = reportTool(session)
  check('user and assistant messages persist research runMode', session.messages.some((message) => message.role === 'user' && message.runMode === 'research') && session.messages.some((message) => message.role === 'assistant' && message.runMode === 'research'))
  check('WebSearch completed against the public web', search?.status === 'done' && search?.metadata?.provider !== 'none' && Number(search?.metadata?.count) > 0, { status: search?.status, output: search?.output, metadata: search?.metadata })
  check('WebRead completed with real Example Domain content', read?.status === 'done' && read?.metadata?.source !== 'none' && read?.metadata?.sourceId === 'S1' && String(read?.output ?? '').includes('Example Domain'), { status: read?.status, output: read?.output, metadata: read?.metadata })
  check('PresentResearchReport returns validated metadata', presentation?.status === 'done' && presentation?.metadata?.researchReport?.title === reportTitle, presentation)
  check('fake provider returns final text after report tool result', session.messages.some((message) => message.role === 'assistant' && message.content.includes('Research report completed and persisted.')))

  const entries = await providerEntries()
  const chatEntries = entries.filter((entry) => entry.method === 'POST' && entry.url === '/v1/chat/completions')
  const firstTurn = chatEntries[0]
  const firstToolNames = toolNamesFromProviderEntry(firstTurn)
  const emittedToolNames = [...new Set(chatEntries.flatMap((entry) => messageToolNames(entry.body?.messages)))]
  check('preload runMode reaches main research-only capability set', JSON.stringify(firstToolNames.sort()) === JSON.stringify(['PresentResearchReport', 'TodoWrite', 'WebRead', 'WebSearch'].sort()), firstToolNames)
  check('research system prompt includes the hard 6/12 budget', firstTurn?.body?.messages?.some((message) => message.role === 'system' && /at most 6 WebSearch calls and 12 WebRead calls/.test(String(message.content))), firstTurn?.body?.messages?.[0]?.content)
  check('provider history records the deterministic research tool sequence', ['TodoWrite', 'WebSearch', 'WebRead', 'PresentResearchReport'].every((name) => emittedToolNames.includes(name)), emittedToolNames)
  check('only one ResearchWebAccess request occurs for the run', await page.evaluate(() => window.__jokerQaApprovalRequests.length) === 1, await page.evaluate(() => window.__jokerQaApprovalRequests))

  const rendered = await inspectRenderedReport(page)
  check('report title renders as a standalone artifact', rendered.articleText.includes(reportTitle))
  const downloadButton = rendered.article.getByRole('button', { name: /下载 Markdown|Download Markdown/i })
  check('valid report exposes an accessible Markdown download button', await downloadButton.isVisible() && !await downloadButton.isDisabled())
  check('report renders at least two sections', rendered.headings.includes('Purpose and identity') && rendered.headings.includes('Smoke-test evidence'), rendered.headings)
  check('source S1 and compact citations render', rendered.articleText.includes('[S1]') && await rendered.citation.innerText() === '[S1]')
  check('ECharts canvas has non-zero dimensions', rendered.canvasMetrics.width > 0 && rendered.canvasMetrics.height > 0 && rendered.canvasMetrics.clientWidth > 0 && rendered.canvasMetrics.clientHeight > 0, rendered.canvasMetrics)
  const dataSummary = rendered.article.getByText(/查看数据表|View data table/i).first()
  await dataSummary.click()
  check('chart data table expands', await rendered.article.locator('table').isVisible() && (await rendered.article.locator('table').innerText()).includes('Verified source'))
  const toolGroupText = await page.locator('button[aria-expanded]').allTextContents()
  check('report is not inside the ordinary collapsible tool group', await rendered.article.evaluate((article) => ![...article.querySelectorAll('button[aria-expanded]')].some((button) => /工具调用|tool calls/i.test(button.textContent ?? ''))) && !toolGroupText.some((text) => /PresentResearchReport/.test(text)), toolGroupText)

  await rendered.citation.click()
  check('citation click expands the exact quote', await rendered.citation.getAttribute('aria-expanded') === 'true' && rendered.articleText.includes('Example Domain') && await rendered.article.getByText('“Example Domain”').isVisible())
  await waitFor(async () => {
    const position = await page.evaluate(() => {
      const source = document.getElementById('research-source-S1')
      if (!source) return null
      const rect = source.getBoundingClientRect()
      return { top: rect.top, bottom: rect.bottom, viewportHeight: window.innerHeight }
    })
    return position !== null && position.bottom > 0 && position.top < position.viewportHeight
  }, 3_000, 'citation source scroll positioning')
  const sourcePosition = await page.evaluate(() => {
    const source = document.getElementById('research-source-S1')
    if (!source) return null
    const rect = source.getBoundingClientRect()
    return { top: rect.top, bottom: rect.bottom, viewportHeight: window.innerHeight }
  })
  check('citation click locates source S1 in the report', sourcePosition !== null && sourcePosition.bottom > 0 && sourcePosition.top < sourcePosition.viewportHeight, sourcePosition)
  await screenshot(page, 'research-report-complete', rendered.article)

  check('renderer has no relevant console errors before restart', consoleEvents.length === 0, consoleEvents)
  check('renderer has no page errors before restart', pageErrors.length === 0, pageErrors)

  await browser.close()
  browser = undefined
  await stopProcess(electron)
  electron = undefined

  page = await launchElectron('restart')
  await waitFor(async () => Boolean(reportTool(await activeSession(page))), 20_000, 'restored report session')
  const restoredSession = await activeSession(page)
  const restoredReport = reportTool(restoredSession)?.metadata?.researchReport
  check('session restart restores report metadata and source', restoredReport?.title === reportTitle && restoredReport?.sources?.[0]?.sourceId === 'S1' && restoredReport?.sources?.[0]?.hostname === 'example.com', restoredReport)
  const restored = await inspectRenderedReport(page)
  check('restart re-renders report title and source S1', restored.articleText.includes(reportTitle) && restored.articleText.includes('[S1]'))
  check('restart restores the accessible Markdown download button', await restored.article.getByRole('button', { name: /下载 Markdown|Download Markdown/i }).isVisible())
  check('restart re-renders non-zero ECharts canvas', restored.canvasMetrics.width > 0 && restored.canvasMetrics.height > 0 && restored.canvasMetrics.clientWidth > 0 && restored.canvasMetrics.clientHeight > 0, restored.canvasMetrics)
  await screenshot(page, 'research-report-restart', restored.article)
  check('renderer has no relevant console errors after restart', consoleEvents.length === 0, consoleEvents)
  check('renderer has no page errors after restart', pageErrors.length === 0, pageErrors)
} catch (error) {
  failure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) }
  try {
    const page = browser?.contexts()?.[0]?.pages()?.[0]
    failureDiagnostics = {
      bodyText: page ? (await page.locator('body').innerText()).slice(-5000) : null,
      session: page ? await activeSession(page) : null,
      providerEntries: (await providerEntries()).map((entry) => ({
        method: entry.method,
        url: entry.url,
        toolNames: toolNamesFromProviderEntry(entry),
        messageToolNames: messageToolNames(entry.body?.messages),
        lastToolResult: Array.isArray(entry.body?.messages) ? [...entry.body.messages].reverse().find((message) => message.role === 'tool')?.content : undefined
      }))
    }
    if (page) await screenshot(page, 'research-failure').catch(() => undefined)
  } catch (diagnosticError) {
    failureDiagnostics = { error: diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError) }
  }
} finally {
  if (browser) await browser.close().catch(() => undefined)
  await stopProcess(electron)
  await stopProcess(provider)
  const report = {
    generatedAt: new Date().toISOString(),
    runDir,
    home,
    electronUserData,
    providerLogPath,
    checks,
    screenshots,
    failure,
    failureDiagnostics,
    consoleErrors: consoleEvents,
    ignoredConsoleErrors: ignoredConsoleEvents,
    ignoredConsoleErrorReason: 'Only ResizeObserver delivery notices, the known Chromium Autofill.enable DevTools noise, and Electron’s own CSP fallback notice are filtered.',
    pageErrors,
    providerOutput,
    electronRuns: electronRuns.map((run) => ({ label: run.label, cdpPort: run.cdpPort, output: run.output })),
    providerExitCode: provider?.exitCode ?? null,
    electronExitCode: electron?.exitCode ?? null
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ reportPath, runDir, checks, screenshots, failure }, null, 2))
  if (failure || checks.some((item) => !item.pass)) process.exitCode = 1
}
