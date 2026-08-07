import { chromium } from 'playwright-core'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { once } from 'node:events'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const runDir = await mkdtemp(join(tmpdir(), 'joker-generated-image-smoke-'))
const home = join(runDir, 'home')
const electronUserData = join(runDir, 'electron-user-data')
const providerLogPath = join(runDir, 'fake-provider.log')
const reportPath = join(runDir, 'report.json')
const providerPort = 23100 + Math.floor(Math.random() * 300)
const cdpPort = 23500 + Math.floor(Math.random() * 300)
const prompt = 'GENERATED_IMAGE_PERSISTENCE_7781 painted clown warrior'
const checks = []
const screenshots = []
const consoleErrors = []
const pageErrors = []
let provider
let electron
let browser
let failure = null
let electronOutput = []

function check(name, value, details) {
  checks.push({ name, pass: Boolean(value), ...(details === undefined ? {} : { details }) })
  if (!value) throw new Error(`Electron generated image smoke failed: ${name}`)
}

async function waitFor(predicate, timeoutMs = 15_000, description = 'condition') {
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

async function persistedGeneratedImage() {
  const sessionFiles = (await readdir(join(home, '.joker', 'sessions'))).filter((name) => name.endsWith('.json'))
  if (sessionFiles.length !== 1) return { sessionFiles, sessionId: null, ref: null, message: null }
  const envelope = JSON.parse(await readFile(join(home, '.joker', 'sessions', sessionFiles[0]), 'utf8'))
  const message = envelope.data.messages.find((candidate) => candidate.role === 'assistant' && candidate.toolCalls?.some((tool) => tool.toolName === 'GenerateImage'))
  const tool = message?.toolCalls?.find((candidate) => candidate.toolName === 'GenerateImage')
  return { sessionFiles, sessionId: envelope.data.id, ref: tool?.metadata?.generatedImages?.[0] ?? null, message }
}

try {
  provider = spawn(process.execPath, [join(root, 'scripts', 'fixtures', 'fake-provider.mjs')], {
    cwd: root,
    env: { ...process.env, PORT: String(providerPort), LOG_PATH: providerLogPath, JOKER_FAKE_SCENARIO: 'image-generation' },
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
  await writeFile(join(home, '.joker', 'image-provider.json'), JSON.stringify({
    providers: [{
      id: 'qa-image-provider', enabled: true, name: 'QA Image Provider', protocol: 'openai-images',
      baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'qa-image-key', model: 'qa-image-model',
      modelsPath: '/models', defaultSize: '1024x1024', defaultAspectRatio: '1:1', defaultResolution: '1k', responseFormat: 'b64_json'
    }],
    activeProviderId: 'qa-image-provider'
  }, null, 2))

  let page = await launchElectron()
  const textarea = page.locator('textarea').first()
  await textarea.fill(`/image ${prompt}`)
  await textarea.press('Enter')
  await page.getByRole('button', { name: /允许|Allow/ }).click()
  await page.waitForFunction(() => !document.querySelector('[data-run-status]'), undefined, { timeout: 30_000 })
  await waitFor(async () => (await persistedGeneratedImage()).ref !== null, 10_000, 'persisted generated image reference')

  const persisted = await persistedGeneratedImage()
  check('generated image assistant message is durable', persisted.sessionFiles.length === 1 && Boolean(persisted.message), persisted)
  check('generated image reference is lightweight JPEG metadata', persisted.ref?.mediaType === 'image/jpeg' && typeof persisted.ref.filename === 'string' && persisted.ref.filename.endsWith('.jpg') && !('base64' in persisted.ref) && !('path' in persisted.ref), persisted.ref)
  const imagePath = join(home, '.joker', 'generated-images', persisted.sessionId, persisted.ref.filename)
  const imageBytes = await readFile(imagePath)
  check('PNG provider output is saved as a valid JPEG file', imageBytes[0] === 0xff && imageBytes[1] === 0xd8 && imageBytes[2] === 0xff && imageBytes.length === persisted.ref.sizeBytes, { imagePath, size: imageBytes.length, refSize: persisted.ref.sizeBytes })
  const readResult = await page.evaluate((ref) => window.joker.generatedImage.read(ref), persisted.ref)
  check('generated image preload read succeeds', readResult.success && readResult.mediaType === 'image/jpeg' && Boolean(readResult.data), { success: readResult.success, mediaType: readResult.mediaType, dataLength: readResult.data?.length })
  await page.getByAltText(persisted.ref.filename).waitFor({ state: 'visible', timeout: 15_000 })
  check('generated image renders after authoritative done reload', await page.getByAltText(persisted.ref.filename).isVisible())
  await screenshot(page, 'generated-image-complete')

  const providerEntries = (await readFile(providerLogPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  const imageRequest = providerEntries.find((entry) => entry.method === 'POST' && entry.url === '/v1/images/generations')
  check('image provider receives the exact prompt and b64 request', imageRequest?.authorization === 'Bearer qa-image-key' && imageRequest.body?.prompt === prompt && imageRequest.body?.response_format === 'b64_json' && imageRequest.body?.size === '1024x1024', imageRequest)

  await closeElectron()
  page = await launchElectron()
  await page.getByAltText(persisted.ref.filename).waitFor({ state: 'visible', timeout: 20_000 })
  const restartedRead = await page.evaluate((ref) => window.joker.generatedImage.read(ref), persisted.ref)
  check('generated image remains readable and rendered after Electron restart', restartedRead.success && restartedRead.data === readResult.data && await page.getByAltText(persisted.ref.filename).isVisible())
  check('generated image file remains present after restart', (await stat(imagePath)).size === persisted.ref.sizeBytes)
  check('renderer has no relevant console errors', consoleErrors.length === 0, consoleErrors)
  check('renderer has no page errors', pageErrors.length === 0, pageErrors)
  await screenshot(page, 'generated-image-restarted')
} catch (error) {
  failure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) }
  try {
    const page = browser?.contexts()?.[0]?.pages()?.[0]
    if (page) await screenshot(page, 'generated-image-failure')
  } catch { /* best effort */ }
} finally {
  await closeElectron()
  await stopProcess(provider)
  const report = { generatedAt: new Date().toISOString(), runDir, checks, screenshots, consoleErrors, pageErrors, failure, electronOutput }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ reportPath, runDir, checks, screenshots, failure }, null, 2))
  if (failure || checks.some((item) => !item.pass)) process.exitCode = 1
}
