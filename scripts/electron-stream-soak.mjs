import { chromium } from 'playwright-core'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { once } from 'node:events'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = new Map()
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index]
  if (!value.startsWith('--')) continue
  const [key, inline] = value.slice(2).split('=', 2)
  args.set(key, inline ?? process.argv[++index])
}
function numberArg(name, fallback, minimum) {
  const value = Number(args.get(name) ?? process.env[`JOKER_STREAM_${name.replaceAll('-', '_').toUpperCase()}`] ?? fallback)
  return Number.isFinite(value) ? Math.max(minimum, Math.floor(value)) : fallback
}
const chunks = numberArg('chunks', 2000, 1)
const consumerDelayMs = numberArg('consumer-delay-ms', 1, 0)
const iterations = numberArg('iterations', 2, 1)
const abortAfterMs = numberArg('abort-after-ms', 120, 0)
const timeoutMs = numberArg('timeout-ms', 90_000, 1_000)
const strict = args.get('strict') === 'true' || args.has('strict')

const runDir = await mkdtemp(join(tmpdir(), 'joker-electron-stream-'))
const home = join(runDir, 'home')
const electronUserData = join(runDir, 'electron-user-data')
const providerLogPath = join(runDir, 'provider.jsonl')
const reportPath = join(runDir, 'report.json')
const providerPort = 18865 + Math.floor(Math.random() * 400)
const cdpPort = 19700 + Math.floor(Math.random() * 400)
const provider = spawn(process.execPath, [join(root, 'scripts', 'fixtures', 'stream-provider.mjs')], {
  cwd: root,
  env: { ...process.env, PORT: String(providerPort), LOG_PATH: providerLogPath, STREAM_CHUNKS: String(chunks), STREAM_CHUNK_DELAY_MS: '0', STREAM_ABORT_CHUNK_DELAY_MS: '10' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
})
const providerOutput = []
const electronOutput = []
let electron
let browser
const checks = []
const runs = []
const screenshots = []

function check(name, pass, details) {
  checks.push({ name, pass: Boolean(pass), ...(details === undefined ? {} : { details }) })
}
function requireCheck(name, pass, details) {
  check(name, pass, details)
  if (!pass) throw new Error(name)
}
function waitForOutput(child, marker, output, timeout = 20_000) {
  if (output.join('').includes(marker)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${marker}: ${output.join('')}`)), timeout)
    const onData = (chunk) => {
      output.push(String(chunk))
      if (output.join('').includes(marker)) {
        clearTimeout(timer)
        child.stdout?.off('data', onData)
        child.stderr?.off('data', onData)
        resolve()
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code, signal) => {
      if (!output.join('').includes(marker)) {
        clearTimeout(timer)
        reject(new Error(`Process exited before ${marker}: code=${code} signal=${signal}`))
      }
    })
  })
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
  electron = spawn(resolve(root, 'node_modules/electron/dist/electron.exe'), [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${electronUserData}`,
    resolve(root, 'out/main/index.js')
  ], {
    cwd: root,
    env: { ...process.env, JOKER_HOME: home, JOKER_E2E_STREAM: '1', ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  const capture = (chunk) => electronOutput.push(String(chunk))
  electron.stdout.on('data', capture)
  electron.stderr.on('data', capture)
  await waitForOutput(electron, 'DevTools listening on', electronOutput)
  const endpoint = electronOutput.join('').match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1]
  if (!endpoint) throw new Error(`Missing CDP endpoint: ${electronOutput.join('')}`)
  browser = await chromium.connectOverCDP(endpoint)
  const page = browser.contexts()[0].pages()[0]
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.__jokerStreamQa?.snapshot().portReady), undefined, { timeout: timeoutMs })
  return page
}
async function waitForRun(page, runId) {
  await page.waitForFunction((id) => {
    const run = window.__jokerStreamQa?.snapshot().runs.find((candidate) => candidate.runId === id)
    return Boolean(run?.terminalCounts.done)
  }, runId, { timeout: timeoutMs })
  return page.evaluate((id) => window.__jokerStreamQa.snapshot().runs.find((run) => run.runId === id), runId)
}
function flowFor(snapshot, runId) {
  const flow = snapshot?.flowState
  return {
    global: flow,
    run: flow?.runs?.[runId] ?? null
  }
}
function boundedBackpressureFor(snapshot, runs) {
  const flow = snapshot?.flowState
  const perRun = runs.map((item) => flowFor(snapshot, item.runId).run)
  const highWaterMark = flow?.highWaterMark ?? 0
  const queueBounded = Boolean(flow && highWaterMark > 0 && flow.maxQueueDepth <= highWaterMark && flow.maxInFlight <= highWaterMark)
  const fullyAcknowledged = Boolean(flow && flow.sentCount === flow.ackCount && flow.queueDepth === 0 && flow.pending === 0 && flow.blockedPending === 0 && flow.inFlight === 0)
  const runAcknowledged = perRun.every((item) => item && item.sentCount === item.ackCount && item.maxQueueDepth <= highWaterMark && item.maxInFlight <= highWaterMark)
  const exercised = Boolean(flow && flow.blockedSends > 0 && flow.resumedCount > 0 && flow.drainCount > 0)
  const noLateEvents = snapshot?.lateEventCount === 0
  return {
    pass: queueBounded && fullyAcknowledged && runAcknowledged && exercised && noLateEvents,
    queueBounded,
    fullyAcknowledged,
    runAcknowledged,
    exercised,
    noLateEvents,
    highWaterMark,
    terminalReserve: flow?.terminalReserve ?? null,
    global: flow ?? null,
    runs: Object.fromEntries(runs.map((item) => [item.runId, flowFor(snapshot, item.runId).run]))
  }
}

function protocolFor(run, expectedChunks, aborted = false) {
  if (!run) return { pass: false, reason: 'run missing' }
  const messageEnds = run.typeCounts['message-end'] ?? 0
  const contextUsages = run.typeCounts['context-usage'] ?? 0
  const expectedContextUsages = aborted ? 1 : 3
  const normalOrder = !run.outOfOrder && run.firstTypes[0] === 'message-start' && messageEnds === (aborted ? 0 : 1) && contextUsages === expectedContextUsages
  const terminal = run.terminalCounts.done === 1 && (aborted ? run.terminalCounts.abort <= 1 : run.terminalCounts.abort === 0) && run.lastTypes.at(-1) === 'done'
  const received = aborted ? run.tokenCount <= expectedChunks : run.tokenCount === expectedChunks
  return { pass: normalOrder && terminal && received, normalOrder, terminal, received, receivedTokens: run.tokenCount, expectedTokens: expectedChunks, outOfOrder: run.outOfOrder, terminalCounts: run.terminalCounts }
}

try {
  await mkdir(home, { recursive: true })
  await waitForOutput(provider, 'STREAM_PROVIDER_READY', providerOutput)
  const configDir = join(home, '.joker')
  await mkdir(configDir, { recursive: true })
  await writeFile(join(configDir, 'config.json'), JSON.stringify({
    providers: [{ id: 'stream-provider', name: 'Stream QA Provider', type: 'openai-compatible', apiFormat: 'chat-completions', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'stream-qa-key', models: [{ id: 'stream-qa', name: 'stream-qa', enabled: true }], currentModelId: 'stream-qa', enabled: true }],
    activeProviderId: 'stream-provider',
    mcpServers: [],
    disabledSkills: []
  }, null, 2))

  const page = await launchElectron()
  requireCheck('real Electron renderer and transferred MessagePort booted', true)
  const session = await page.evaluate(() => window.joker.session.create('Stream qualification session'))
  requireCheck('real session created through preload', Boolean(session?.id))
  await page.evaluate((delay) => window.__jokerStreamQa.setConsumerDelay(delay), consumerDelayMs)

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const runId = `burst-${iteration}-${crypto.randomUUID()}`
    const startedAt = Date.now()
    await page.evaluate(({ sessionId, runId }) => window.__jokerStreamQa.send(sessionId, [{ role: 'user', content: `burst ${runId}` }], runId), { sessionId: session.id, runId })
    const run = await waitForRun(page, runId)
    const protocol = protocolFor(run, chunks)
    runs.push({ kind: 'burst', iteration, runId, startedAt, finishedAt: Date.now(), run, protocol })
    requireCheck(`burst iteration ${iteration} preserves MessagePort FIFO and terminal sequence`, protocol.pass, protocol)
  }

  const abortRunId = `abort-${crypto.randomUUID()}`
  await page.evaluate(({ sessionId, runId }) => window.__jokerStreamQa.send(sessionId, [{ role: 'user', content: `abort STREAM_ABORT_TEST ${runId}` }], runId), { sessionId: session.id, runId: abortRunId })
  await new Promise((resolve) => setTimeout(resolve, abortAfterMs))
  await page.evaluate((runId) => window.__jokerStreamQa.abort(runId), abortRunId)
  const abortRun = await waitForRun(page, abortRunId)
  const abortProtocol = protocolFor(abortRun, chunks, true)
  runs.push({ kind: 'abort', runId: abortRunId, abortAfterMs, finishedAt: Date.now(), run: abortRun, protocol: abortProtocol })
  requireCheck('abort produces at most one abort and exactly one final done', abortProtocol.pass, abortProtocol)

  const snapshot = await page.evaluate(() => window.__jokerStreamQa.snapshot())
  const memory = await page.evaluate(() => performance.memory ? { usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize } : null)
  await page.screenshot({ path: join(runDir, 'stream-soak-final.png') })
  screenshots.push(join(runDir, 'stream-soak-final.png'))
  const providerStats = await fetch(`http://127.0.0.1:${providerPort}/stats`).then((response) => response.json())
  const boundedBackpressure = boundedBackpressureFor(snapshot, runs)
  check('slow consumer completes without protocol loss', runs.filter((item) => item.kind === 'burst').every((item) => item.protocol.pass), { consumerDelayMs, chunks, iterations })
  check('bounded backpressure is proven', boundedBackpressure.pass, boundedBackpressure)
  if (strict && !boundedBackpressure.pass) throw new Error('Strict backpressure mode failed: observed bounded queue/ACK/drain contract did not pass')

  const report = {
    generatedAt: new Date().toISOString(),
    command: process.argv.slice(1).join(' '),
    node: process.version,
    platform: process.platform,
    runDir,
    configuration: { chunks, consumerDelayMs, iterations, abortAfterMs, timeoutMs, strict },
    protocolChecks: checks,
    runs,
    rendererSnapshot: snapshot,
    rendererMemory: memory,
    providerStats,
    providerOutput,
    electronOutput,
    screenshots,
    backpressureObservation: { ...boundedBackpressure, consumerDelayMs, chunks, iterations, note: 'Application-level event-window evidence: pending + in-flight queue depth is bounded by the configured high-water mark; this is not a byte-level memory SLA.' },
    limitations: [
      'The contract bounds application-level event envelopes by count; Electron internal queue bytes and upstream socket buffers are not directly observable.',
      'This is a local Windows Electron qualification run, not a CI gate, production SLA, or cross-platform package guarantee.',
      'Provider and renderer are local test fixtures; no external network or credentials are used.'
    ],
    failure: null
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ reportPath, runDir, checks, runs: runs.map(({ kind, iteration, runId, protocol }) => ({ kind, iteration, runId, protocol })), boundedBackpressure }, null, 2))
  if (checks.some((item) => !item.pass)) process.exitCode = 1
} catch (error) {
  const report = {
    generatedAt: new Date().toISOString(),
    command: process.argv.slice(1).join(' '),
    node: process.version,
    platform: process.platform,
    runDir,
    configuration: { chunks, consumerDelayMs, iterations, abortAfterMs, timeoutMs, strict },
    protocolChecks: checks,
    runs,
    providerOutput,
    electronOutput,
    screenshots,
    backpressureObservation: { boundedBackpressure: false },
    limitations: ['Harness failed before all protocol checks completed.'],
    failure: error instanceof Error ? error.stack : String(error)
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.error(JSON.stringify({ reportPath, runDir, failure: report.failure }, null, 2))
  process.exitCode = 1
} finally {
  if (browser) await browser.close().catch(() => undefined)
  await stopProcess(electron)
  await stopProcess(provider)
}
