import { chromium } from 'playwright-core'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { once } from 'node:events'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const runDir = await mkdtemp(join(tmpdir(), 'joker-renderer-stream-'))
const jokerHomeDir = join(runDir, 'home')
const electronUserData = join(runDir, 'electron-user-data')
const reportPath = join(runDir, 'report.json')
const screenshotPath = join(runDir, 'renderer-stream-final.png')
const providerPort = 20100 + Math.floor(Math.random() * 400)
const cdpPort = 20500 + Math.floor(Math.random() * 400)
const chunkCount = 2000
const providerOutput = []
const electronOutput = []
const consoleErrors = []
const pageErrors = []
const checks = []
let provider
let electron
let browser

function check(name, pass, details) {
  checks.push({ name, pass: Boolean(pass), ...(details === undefined ? {} : { details }) })
  if (!pass) throw new Error(name)
}

function waitForOutput(child, marker, output, timeout = 20_000) {
  if (output.join('').includes(marker)) return Promise.resolve()
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${marker}: ${output.join('')}`)), timeout)
    const onData = (chunk) => {
      output.push(String(chunk))
      if (!output.join('').includes(marker)) return
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.stderr?.off('data', onData)
      resolvePromise()
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('error', reject)
  })
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

function createHistory() {
  return Array.from({ length: 224 }, (_, index) => {
    const role = index % 2 === 0 ? 'user' : 'assistant'
    if (role === 'user') {
      return {
        id: `renderer-history-user-${index}`,
        role,
        content: `Historical request ${index} ${'request '.repeat(20)}`,
        createdAt: index + 1
      }
    }
    const tools = Array.from({ length: 8 }, (_, toolIndex) => ({
      toolCallId: `renderer-tool-${index}-${toolIndex}`,
      toolName: toolIndex % 2 === 0 ? 'Bash' : 'Read',
      input: toolIndex % 2 === 0 ? { command: `echo ${index}-${toolIndex}` } : { filePath: `C:\\fixture\\${index}-${toolIndex}.txt` },
      output: `tool output ${index}-${toolIndex}\n${'x'.repeat(1800)}`,
      status: 'done'
    }))
    const content = `Historical response ${index}\n\n**Completed** with representative content.`
    return {
      id: `renderer-history-assistant-${index}`,
      role,
      content,
      toolCalls: tools,
      segments: [{ type: 'text', text: content }, { type: 'tools', tools }],
      createdAt: index + 1
    }
  })
}

try {
  await mkdir(join(jokerHomeDir, '.joker'), { recursive: true })
  provider = spawn(process.execPath, [join(root, 'scripts', 'fixtures', 'stream-provider.mjs')], {
    cwd: root,
    env: { ...process.env, PORT: String(providerPort), STREAM_CHUNKS: String(chunkCount), STREAM_CHUNK_DELAY_MS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  await waitForOutput(provider, 'STREAM_PROVIDER_READY', providerOutput)
  await writeFile(join(jokerHomeDir, '.joker', 'config.json'), JSON.stringify({
    providers: [{ id: 'renderer-perf', name: 'Renderer Performance', type: 'openai-compatible', apiFormat: 'chat-completions', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'renderer-perf-key', models: [{ id: 'stream-qa', name: 'stream-qa', enabled: true }], currentModelId: 'stream-qa', enabled: true }],
    activeProviderId: 'renderer-perf',
    mcpServers: [],
    disabledSkills: []
  }, null, 2))

  electron = spawn(resolve(root, 'node_modules/electron/dist/electron.exe'), [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${electronUserData}`,
    resolve(root, 'out/main/index.js')
  ], {
    cwd: root,
    env: { ...process.env, HOME: jokerHomeDir, USERPROFILE: jokerHomeDir, JOKER_HOME: jokerHomeDir, ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  const captureElectron = (chunk) => electronOutput.push(String(chunk))
  electron.stdout.on('data', captureElectron)
  electron.stderr.on('data', captureElectron)
  await waitForOutput(electron, 'DevTools listening on', electronOutput)
  const endpoint = electronOutput.join('').match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1]
  check('Electron exposes CDP', Boolean(endpoint))
  browser = await chromium.connectOverCDP(endpoint)
  const page = browser.contexts()[0].pages()[0]
  page.on('console', (message) => {
    if (message.type() === 'error' && !/Autofill\.enable|script-src.*default-src.*fallback/i.test(message.text())) consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForSelector('textarea')

  const history = createHistory()
  const seededSessionId = await page.evaluate(async (messages) => {
    const session = await window.joker.session.create('Renderer performance qualification')
    const saved = await window.joker.session.replaceMessages(session.id, messages)
    if (!saved) throw new Error('failed to seed renderer history')
    return session.id
  }, history)
  check('large representative session is seeded', Boolean(seededSessionId), { messages: history.length, toolCalls: 896 })

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-message-row]')
  const initialRows = await page.locator('[data-message-row]').count()
  const historyWindowText = await page.locator('[data-history-window]').innerText()
  check('initial DOM mounts only the recent message window', initialRows === 60, { initialRows, historyWindowText })

  const beforePrepend = await page.locator('[data-message-stream-scroll]').evaluate((element) => {
    element.scrollTop = 0
    return { scrollTop: element.scrollTop, scrollHeight: element.scrollHeight }
  })
  await page.locator('[data-history-window]').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-message-row]').length === 100)
  const afterPrepend = await page.locator('[data-message-stream-scroll]').evaluate((element) => ({ scrollTop: element.scrollTop, scrollHeight: element.scrollHeight }))
  const expectedScrollTop = beforePrepend.scrollTop + (afterPrepend.scrollHeight - beforePrepend.scrollHeight)
  check('loading earlier messages expands by one page and preserves the reading anchor', Math.abs(afterPrepend.scrollTop - expectedScrollTop) < 8, { beforePrepend, afterPrepend, expectedScrollTop })

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelectorAll('[data-message-row]').length === 60)
  await page.evaluate(() => {
    window.__rendererPerf = { mutationBatches: 0, longTasks: [] }
    const target = document.querySelector('[data-message-stream-content]')
    const mutationObserver = new MutationObserver(() => {
      if (document.querySelector('[data-streaming-reply]')) window.__rendererPerf.mutationBatches += 1
    })
    if (target) mutationObserver.observe(target, { childList: true, characterData: true, subtree: true })
    if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      const longTaskObserver = new PerformanceObserver((list) => {
        window.__rendererPerf.longTasks.push(...list.getEntries().map((entry) => entry.duration))
      })
      longTaskObserver.observe({ type: 'longtask', buffered: true })
    }
  })

  const beforeStream = await page.evaluate(() => ({
    now: performance.now(),
    heap: performance.memory ? performance.memory.usedJSHeapSize : null,
    domNodes: document.getElementsByTagName('*').length
  }))
  const textarea = page.locator('textarea').first()
  await textarea.fill('renderer stream performance qualification')
  await textarea.press('Enter')
  await page.waitForFunction((lastToken) => document.body.innerText.includes(lastToken), `stream-token-${chunkCount - 1};`, { timeout: 90_000 })
  const lastTokenAt = await page.evaluate(() => performance.now())
  await page.waitForFunction(() => !document.querySelector('[data-streaming-reply]') && document.body.innerText.includes('stream-token-1999;'), undefined, { timeout: 90_000 })
  const afterStream = await page.evaluate(() => ({
    now: performance.now(),
    heap: performance.memory ? performance.memory.usedJSHeapSize : null,
    domNodes: document.getElementsByTagName('*').length,
    rows: document.querySelectorAll('[data-message-row]').length,
    mutationBatches: window.__rendererPerf?.mutationBatches ?? null,
    longTasks: window.__rendererPerf?.longTasks ?? []
  }))
  const streamElapsedMs = lastTokenAt - beforeStream.now
  const maxLongTaskMs = afterStream.longTasks.length > 0 ? Math.max(...afterStream.longTasks) : 0
  check('all provider chunks reach the real rendered conversation', streamElapsedMs < 90_000, { streamElapsedMs, chunkCount })
  check('token batching materially reduces rendered mutation batches', afterStream.mutationBatches !== null && afterStream.mutationBatches < chunkCount / 4, { mutationBatches: afterStream.mutationBatches, chunkCount })
  check('long-session DOM remains windowed after streaming', afterStream.rows <= 60 && afterStream.domNodes < 15_000, { rows: afterStream.rows, domNodes: afterStream.domNodes })
  check('real renderer completes without page errors', pageErrors.length === 0 && consoleErrors.length === 0, { pageErrors, consoleErrors })
  await page.screenshot({ path: screenshotPath })

  const report = {
    generatedAt: new Date().toISOString(),
    runDir,
    reportPath,
    screenshotPath,
    configuration: { historyMessages: history.length, historyToolCalls: 896, chunkCount },
    checks,
    measurements: {
      initialRows,
      historyWindowText,
      beforePrepend,
      afterPrepend,
      beforeStream,
      afterStream,
      streamElapsedMs,
      finalizeElapsedMs: afterStream.now - lastTokenAt,
      maxLongTaskMs,
      heapDeltaBytes: beforeStream.heap === null || afterStream.heap === null ? null : afterStream.heap - beforeStream.heap
    },
    consoleErrors,
    pageErrors,
    providerOutput,
    electronOutput
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ reportPath, screenshotPath, checks, measurements: report.measurements }, null, 2))
} catch (error) {
  const failure = error instanceof Error ? error.stack : String(error)
  await writeFile(reportPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), runDir, checks, consoleErrors, pageErrors, failure, providerOutput, electronOutput }, null, 2)}\n`).catch(() => undefined)
  console.error(JSON.stringify({ reportPath, failure, checks }, null, 2))
  process.exitCode = 1
} finally {
  if (browser) await browser.close().catch(() => undefined)
  await stopProcess(electron)
  await stopProcess(provider)
}
