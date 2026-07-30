import { chromium } from 'playwright-core'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { once } from 'node:events'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const runDir = await mkdtemp(join(tmpdir(), 'joker-electron-context-optimization-'))
const home = join(runDir, 'home')
const electronUserData = join(runDir, 'electron-user-data')
const providerLogPath = join(runDir, 'fake-provider.log')
const reportPath = join(runDir, 'report.json')
const providerPort = 22765 + Math.floor(Math.random() * 400)
const cdpPortBase = 23200 + Math.floor(Math.random() * 300)
const sentinel = 'CONTEXT_ELECTRON_SENTINEL_7781'
const checks = []
const integrationPoints = []
const consoleErrors = []
const pageErrors = []
const screenshots = []
const electronRuns = []
let provider
let electron
let browser
let failure = null
let launchCount = 0

function recordCheck(id, status, expected, observed, details = undefined) {
  checks.push({ id, status, expected, observed, ...(details === undefined ? {} : { details }) })
}
function requireCheck(id, pass, expected, observed, details = undefined) {
  recordCheck(id, pass ? 'pass' : 'fail', expected, observed, details)
  if (!pass) throw new Error(`Electron context optimization smoke failed: ${id}`)
}
function pending(id, expected, observed, integrationPoint) {
  recordCheck(id, 'integration-pending', expected, observed)
  integrationPoints.push(integrationPoint)
}
async function waitFor(predicate, timeoutMs = 10_000, label = 'condition') {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try { if (await predicate()) return } catch (error) { lastError = error }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
  }
  throw new Error(`Timed out waiting for ${label}${lastError instanceof Error ? `: ${lastError.message}` : ''}`)
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
    await Promise.race([once(child, 'exit'), new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000))])
    if (child.exitCode === null) child.kill('SIGKILL')
  }
}
function parseLines(text) {
  return text.split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } })
}
async function providerEntries() {
  try { return parseLines(await readFile(providerLogPath, 'utf8')) } catch { return [] }
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
    env: { ...process.env, HOME: home, USERPROFILE: home, JOKER_HOME: home, ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  })
  const onData = (chunk) => output.push(String(chunk))
  electron.stdout.on('data', onData)
  electron.stderr.on('data', onData)
  const ws = await new Promise((resolveWs, reject) => {
    let settled = false
    const finish = (callback, value) => { if (settled) return; settled = true; clearTimeout(timer); callback(value) }
    const inspect = () => {
      const match = output.join('').match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (match) finish(resolveWs, match[1])
    }
    electron.stdout.on('data', inspect)
    electron.stderr.on('data', inspect)
    electron.once('error', (error) => finish(reject, error))
    electron.once('exit', (code, signal) => finish(reject, new Error(`Electron exited before CDP: ${code}/${signal}; ${output.join('')}`)))
    const timer = setTimeout(() => finish(reject, new Error(`Electron did not expose CDP: ${output.join('')}`)), 20_000)
    inspect()
  })
  browser = await chromium.connectOverCDP(ws)
  const context = browser.contexts()[0]
  await waitFor(() => context.pages().length > 0, 10_000, `${label} page`)
  const page = context.pages()[0]
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push({ launch: label, text: message.text(), location: message.location() }) })
  page.on('pageerror', (error) => pageErrors.push({ launch: label, message: error.message, stack: error.stack }))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.joker?.config?.get && window.joker?.session?.get && window.joker?.chat?.onEvent))
  electronRuns.push({ label, cdpPort, output })
  return page
}
function largeOriginalOutput() {
  const rows = Array.from({ length: 2200 }, (_, index) => `row=${String(index).padStart(4, '0')} status=ok repeated=context-optimization-electron-smoke payload=${'x'.repeat(80)}`)
  rows.splice(1471, 0, `${sentinel} error_code=CTX_ELECTRON_991 path=E:\\joker\\src\\main\\agent\\context.ts:247 must_not_delete=true`)
  return rows.join('\n')
}
async function startRun(page, sessionId, messages) {
  return page.evaluate(({ targetSessionId, targetMessages }) => new Promise((resolvePromise, reject) => {
    const events = []
    const port = new MessageChannel().port1
    let timeout
    window.joker.chat.onPort((streamPort) => {
      window.joker.chat.onEvent(streamPort, (event) => {
        events.push(event)
        if (event.type === 'done') { clearTimeout(timeout); resolvePromise(events) }
      })
      const runId = `context-electron-${Date.now()}`
      window.joker.chat.send(streamPort, targetSessionId, targetMessages, 'none', [], undefined, runId, 'chat')
    })
    timeout = setTimeout(() => reject(new Error(`run timeout; events=${JSON.stringify(events.slice(-10))}`)), 120_000)
    void port
  }), { targetSessionId: sessionId, targetMessages: messages })
}

try {
  provider = spawn(process.execPath, [join(root, 'scripts', 'fixtures', 'fake-provider.mjs')], {
    cwd: root,
    env: { ...process.env, PORT: String(providerPort), LOG_PATH: providerLogPath, JOKER_FAKE_SCENARIO: 'context-optimization' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  })
  await new Promise((resolveReady, reject) => {
    const output = []
    const inspect = (chunk) => { output.push(String(chunk)); if (output.join('').includes('FAKE_PROVIDER_READY')) resolveReady() }
    provider.stdout.on('data', inspect); provider.stderr.on('data', inspect); provider.once('error', reject)
    provider.once('exit', (code, signal) => { if (code !== 0) reject(new Error(`Fake provider exited: ${code}/${signal}; ${output.join('')}`)) })
  })
  await mkdir(join(home, '.joker'), { recursive: true })
  await mkdir(electronUserData, { recursive: true })
  await writeFile(join(home, '.joker', 'config.json'), JSON.stringify({
    providers: [{ id: 'qa-provider', name: 'QA Context Provider', type: 'openai-compatible', apiFormat: 'chat-completions', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'qa-context-key', models: [{ id: 'gpt-4o', name: 'gpt-4o', enabled: true, maxContextTokens: 24_000 }], currentModelId: 'gpt-4o', enabled: true, promptCache: false }],
    activeProviderId: 'qa-provider', mcpServers: [], disabledSkills: [], contextOptimizationMode: 'v2'
  }, null, 2))

  let page = await launchElectron('initial')
  const config = await page.evaluate(() => window.joker.config.get())
  if (Object.prototype.hasOwnProperty.call(config, 'contextOptimizationMode')) {
    requireCheck('mode-loaded', config.contextOptimizationMode === 'v2', 'v2 mode loads from config', config.contextOptimizationMode)
    const saved = await page.evaluate(async () => { const current = await window.joker.config.get(); return window.joker.config.save({ ...current, contextOptimizationMode: 'observe' }) })
    requireCheck('mode-save', saved === true, 'mode save succeeds', saved)
  } else {
    pending('mode-loaded', 'AppConfig/context store supports legacy|observe|v2|disabled', Object.keys(config), 'Add contextOptimizationMode to AppConfig, config normalization/persistence, and settings UI.')
  }

  const session = await page.evaluate(() => window.joker.session.create('Context optimization Electron smoke'))
  const originalOutput = largeOriginalOutput()
  const originalMessages = [
    { id: 'ctx-user-1', role: 'user', content: 'Inspect the large tool result and retrieve protected original evidence if the projection is compressed.', createdAt: 1 },
    { id: 'ctx-assistant-1', role: 'assistant', content: '', toolCalls: [{ toolCallId: 'ctx-tool-1', toolName: 'Bash', input: { command: 'context qualification' }, output: originalOutput, status: 'done' }], createdAt: 2 },
    { id: 'ctx-user-2', role: 'user', content: `Find ${sentinel}; preserve error_code=CTX_ELECTRON_991 and must_not_delete=true.`, createdAt: 3 }
  ]
  requireCheck('session-seed', await page.evaluate(({ id, messages }) => window.joker.session.replaceMessages(id, messages), { id: session.id, messages: originalMessages }), 'session seed succeeds', true)
  const before = await page.evaluate((id) => window.joker.session.get(id), session.id)
  requireCheck('session-original-before', before.messages[1].toolCalls[0].output === originalOutput, 'Session stores byte-identical original tool output', before.messages[1].toolCalls[0].output.length)

  const runEvents = await startRun(page, session.id, originalMessages)
  const contextEvents = runEvents.filter((event) => event.type === 'context-usage')
  const toolCalls = runEvents.filter((event) => event.type === 'tool-call')
  const tokens = runEvents.filter((event) => event.type === 'token').map((event) => event.text).join('')
  const after = await page.evaluate((id) => window.joker.session.get(id), session.id)
  requireCheck('session-original-after', after.messages.find((message) => message.id === 'ctx-assistant-1')?.toolCalls?.[0]?.output === originalOutput, 'compression projection never mutates Session original', after.messages.find((message) => message.id === 'ctx-assistant-1')?.toolCalls?.[0]?.output?.length)

  const entries = (await providerEntries()).filter((entry) => entry.method === 'POST' && entry.url === '/v1/chat/completions')
  const sentMessages = entries[0]?.body?.messages ?? []
  const sentSerialized = JSON.stringify(sentMessages)
  const projectionCompressed = sentSerialized.length < originalOutput.length && sentSerialized.includes(sentinel)
  if (projectionCompressed) requireCheck('compressed-projection', true, 'provider receives shorter projection while protected sentinel remains', { requestChars: sentSerialized.length, originalChars: originalOutput.length })
  else pending('compressed-projection', 'provider receives v2 compressed projection with context reference and sentinel', { requestChars: sentSerialized.length, originalChars: originalOutput.length, sentinelPresent: sentSerialized.includes(sentinel) }, 'Wire contextOptimizationMode=v2 into runAgent and emit retrievable compressed projections instead of the current legacy/no-op path.')

  const retrieveCall = toolCalls.find((event) => event.toolName === 'ContextRetrieve')
  if (retrieveCall) {
    requireCheck('context-retrieve-call', Boolean(retrieveCall.input?.contextId), 'fake provider invokes ContextRetrieve with a stable contextId', retrieveCall.input)
    requireCheck('context-retrieve-result', tokens.includes('retrieval completed'), 'ContextRetrieve result returns to provider and final text completes', tokens)
  } else {
    pending('context-retrieve-call', 'ContextRetrieve is exposed and invoked for the current session reference', { toolCalls: toolCalls.map((event) => event.toolName), finalText: tokens }, 'Register ContextRetrieve in the product tool registry and bind contextId to current session/message/toolCall/content hash.')
  }

  const metrics = contextEvents.map((event) => event.usage)
  const hasOptimizationMetrics = metrics.some((usage) => usage && ('estimatedNetSavedTokens' in usage || 'summaryInputTokens' in usage || 'retrievalInputTokens' in usage || 'transforms' in usage || 'mode' in usage))
  if (hasOptimizationMetrics) requireCheck('context-ui-metrics-event', true, 'context-usage event includes optimization metrics', metrics)
  else pending('context-ui-metrics-event', 'context-usage includes mode, transform, summary/retrieval costs, estimated net saving', metrics, 'Extend ContextUsage/stream events and ContextUsageIndicator with measured-vs-estimated optimization metrics.')
  const indicator = page.locator('button[aria-label*="Context"], button[aria-label*="上下文"]').first()
  if (await indicator.count()) {
    await indicator.click()
    const bodyText = await page.locator('body').innerText()
    const displaysMetrics = /净节省|net sav|summary|retrieval|transform|压缩/i.test(bodyText)
    if (displaysMetrics) requireCheck('context-ui-metrics-rendered', true, 'ContextUsageIndicator renders optimization metrics', bodyText.slice(-1200))
    else pending('context-ui-metrics-rendered', 'UI renders mode, transform, summary/retrieval cost, and estimated net saving', bodyText.slice(-1200), 'Add optimization metric rows and estimated labels to ContextUsageIndicator.')
  } else {
    pending('context-ui-metrics-rendered', 'ContextUsageIndicator is visible after run', 'indicator not found', 'Ensure context-usage events populate the renderer indicator for this deterministic run.')
  }
  await screenshot(page, 'context-optimization-initial')

  await browser.close(); browser = undefined
  await stopProcess(electron); electron = undefined
  page = await launchElectron('restart')
  const restoredConfig = await page.evaluate(() => window.joker.config.get())
  if (Object.prototype.hasOwnProperty.call(config, 'contextOptimizationMode')) requireCheck('mode-persisted', restoredConfig.contextOptimizationMode === 'observe', 'saved optimization mode survives restart', restoredConfig.contextOptimizationMode)
  else pending('mode-persisted', 'optimization mode survives restart', Object.keys(restoredConfig), 'Persist the normalized contextOptimizationMode in config.json.')
  const restoredSession = await page.evaluate((id) => window.joker.session.get(id), session.id)
  requireCheck('session-original-restart', restoredSession.messages.find((message) => message.id === 'ctx-assistant-1')?.toolCalls?.[0]?.output === originalOutput, 'Session original survives Electron restart byte-identically', restoredSession.messages.find((message) => message.id === 'ctx-assistant-1')?.toolCalls?.[0]?.output?.length)
  await screenshot(page, 'context-optimization-restart')
  requireCheck('no-console-errors', consoleErrors.length === 0, 'no renderer console errors', consoleErrors)
  requireCheck('no-page-errors', pageErrors.length === 0, 'no page errors', pageErrors)
} catch (error) {
  failure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) }
} finally {
  if (browser) await browser.close().catch(() => undefined)
  await stopProcess(electron)
  await stopProcess(provider)
  const failed = checks.some((check) => check.status === 'fail') || Boolean(failure)
  const integrationPending = checks.some((check) => check.status === 'integration-pending')
  const report = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), status: failed ? 'fail' : integrationPending ? 'integration-pending' : 'pass',
    runDir, home, electronUserData, providerLogPath, checks, integrationPoints: [...new Set(integrationPoints)], screenshots,
    consoleErrors, pageErrors, failure, electronRuns: electronRuns.map((run) => ({ label: run.label, cdpPort: run.cdpPort, output: run.output }))
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ reportPath, status: report.status, checks, integrationPoints: report.integrationPoints, failure }, null, 2))
  if (failed) process.exitCode = 1
}
