// Real-chain verification for the D slice:
//  D1 whole-window image drag & drop -> overlay -> composer attachment rail.
//  D2 lightbox zoom/pan controls on message images.
//  D3 per-turn ProducedFiles chips: Write/Edit tool calls surface clickable file chips.
import { chromium } from 'playwright-core'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { once } from 'node:events'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const runDir = await mkdtemp(join(tmpdir(), 'joker-electron-ui-d-'))
const home = join(runDir, 'home')
const workspace = join(runDir, 'workspace')
const logPath = join(runDir, 'fake-provider.log')
const reportPath = join(runDir, 'report.json')
const providerPort = 25200 + Math.floor(Math.random() * 400)
const cdpPort = 25700 + Math.floor(Math.random() * 400)
const checks = []
const screenshots = []
const consoleErrors = []
const pageErrors = []

function check(name, value, details = undefined) {
  const result = { name, pass: Boolean(value), ...(details === undefined ? {} : { details }) }
  checks.push(result)
  if (!result.pass) throw new Error(`UI D smoke failed: ${name}`)
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

// 1x1 red PNG.
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let provider
let electron
let browser
let failure = null
try {
  provider = spawn(process.execPath, [join(root, 'scripts', 'fixtures', 'fake-provider.mjs')], {
    cwd: root,
    env: { ...process.env, PORT: String(providerPort), LOG_PATH: logPath, JOKER_FAKE_SCENARIO: 'produced-files' },
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
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'config.md'), 'line 1\nline 2\n', 'utf8')
  await writeFile(join(home, '.joker', 'config.json'), JSON.stringify({
    providers: [{
      id: 'qa-provider',
      name: 'QA Files Provider',
      type: 'openai-compatible',
      apiFormat: 'chat-completions',
      baseUrl: `http://127.0.0.1:${providerPort}/v1`,
      apiKey: 'qa-files-key',
      models: [{ id: 'gpt-4o', name: 'gpt-4o', enabled: true }],
      currentModelId: 'gpt-4o',
      enabled: true
    }],
    activeProviderId: 'qa-provider',
    mcpServers: [],
    approvalMode: 'full-auto'
  }, null, 2))
  await writeFile(join(home, '.joker', 'projects.json'), JSON.stringify({
    projects: [{ id: 'ui-d-workspace', name: 'UI D Workspace', path: workspace, lastUsedAt: Date.now() }],
    activeProjectId: 'ui-d-workspace'
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

  // Bind the session to the workspace so Write/Edit run against real files.
  await page.evaluate(() => window.joker.approval.setMode('full-auto'))
  const projectsState = await page.evaluate(() => window.joker.project.get())
  const activeProjectId = projectsState.state?.activeProjectId
  check('workspace project loaded from seed', Boolean(activeProjectId), JSON.stringify(projectsState).slice(0, 300))
  const sessionList = await page.evaluate(() => window.joker.session.list())
  const sessionId = sessionList[0]?.id
  const bound = await page.evaluate(({ sid, pid }) => window.joker.session.setProject(sid, pid), { sid: sessionId, pid: activeProjectId })
  check('session bound to workspace project', bound === true, String(bound))
  await page.waitForTimeout(800)

  const textarea = page.locator('textarea').first()

  // ---- D3: ProducedFiles chips after a Write + Edit turn.
  await textarea.fill('write the files please')
  await textarea.press('Enter')
  await page.waitForFunction(() => document.body.innerText.includes('Produced-files QA completed'), undefined, { timeout: 90_000 })
  const producedDump = await page.evaluate(async () => {
    const sessions = await window.joker.session.list()
    const session = await window.joker.session.get(sessions[0].id)
    const assistant = [...session.messages].reverse().find((message) => message.role === 'assistant')
    return {
      domChips: [...document.querySelectorAll('[data-produced-file]')].map((node) => node.getAttribute('data-produced-file')),
      domProducedSections: document.querySelectorAll('[data-produced-files]').length,
      toolCalls: (assistant?.toolCalls ?? []).map((tool) => ({ name: tool.toolName, status: tool.status, input: tool.input?.filePath, output: String(tool.output ?? '').slice(0, 60) })),
      segments: (assistant?.segments ?? []).map((segment) => segment.type)
    }
  })
  const chips = producedDump.domChips
  check('produced-files chips list both mutated files', chips.length === 2 && chips.includes('notes.txt') && chips.includes('config.md'), producedDump)
  const producedLabel = await page.evaluate(() => document.body.innerText.includes('本轮产出') || document.body.innerText.includes('Produced'))
  check('produced-files label is visible', producedLabel)
  const filesOnDisk = await page.evaluate(async () => {
    const project = await window.joker.project.get()
    return project
  })
  check('workspace project still active after run', Boolean(filesOnDisk))
  await page.screenshot({ path: join(runDir, 'produced-files.png') })
  screenshots.push(join(runDir, 'produced-files.png'))

  // ---- D1: whole-window drag & drop.
  const dragDropWorked = await page.evaluate(async (base64) => {
    try {
      const byteString = atob(base64)
      const bytes = new Uint8Array(byteString.length)
      for (let i = 0; i < byteString.length; i += 1) bytes[i] = byteString.charCodeAt(i)
      const file = new File([bytes], 'dropped-qa.png', { type: 'image/png' })
      const dt = new DataTransfer()
      dt.items.add(file)
      const target = document.body
      const fire = (type) => target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
      fire('dragenter')
      await new Promise((resolve) => setTimeout(resolve, 120))
      const overlay = document.querySelector('[data-drop-overlay="active"]')
      if (!overlay) return { overlay: false, attached: 0, types: [...dt.types], hasDt: Boolean(new DragEvent('dragenter', { dataTransfer: dt }).dataTransfer) }
      fire('dragover')
      fire('drop')
      await new Promise((resolve) => setTimeout(resolve, 600))
      const thumbs = document.querySelectorAll('[data-image-preview="thumbnail"]').length
      return { overlay: true, attached: thumbs, types: [...dt.types] }
    } catch (error) {
      return { overlay: false, error: String(error) }
    }
  }, TINY_PNG_BASE64)
  check('drop overlay appears during file drag', dragDropWorked.overlay === true, dragDropWorked)
  check('dropped image lands in the composer attachment rail', dragDropWorked.attached === 1, dragDropWorked)
  await page.screenshot({ path: join(runDir, 'drop-overlay-rail.png') })
  screenshots.push(join(runDir, 'drop-overlay-rail.png'))

  // ---- D2: lightbox zoom controls on an attached image.
  await page.click('[data-image-preview="thumbnail"]')
  await page.waitForSelector('[data-lightbox-image]', { timeout: 10_000 })
  const initialScale = await page.locator('[data-lightbox-scale]').innerText()
  await page.locator('button[aria-label="放大"], button[aria-label="Zoom in"]').click()
  const zoomedScale = await page.locator('[data-lightbox-scale]').innerText()
  check('lightbox opens at 100% and zoom-in raises the scale', initialScale.includes('100') && zoomedScale.includes('140'), { initialScale, zoomedScale })
  await page.locator('button[aria-label="重置缩放"], button[aria-label="Reset zoom"]').click()
  const resetScale = await page.locator('[data-lightbox-scale]').innerText()
  check('reset zoom returns to 100%', resetScale.includes('100'), resetScale)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  check('escape closes the lightbox', (await page.locator('[data-lightbox-image]').count()) === 0)

  // Image actually rides the next message when sent.
  await textarea.fill('here is the dropped image')
  await textarea.press('Enter')
  // The produced-files fixture keys off tool history, so a follow-up turn in the
  // same session completes with the fixture summary text rather than the online line.
  await page.waitForFunction(() => document.body.innerText.includes('Fake Provider is online.') || document.body.innerText.includes('Produced-files QA completed'), undefined, { timeout: 60_000 })
  const attachmentRendered = await page.evaluate(() => document.querySelectorAll('[data-image-preview="attachment"]').length)
  check('sent message renders the image in the transcript', attachmentRendered >= 1, { attachmentRendered })
  await page.screenshot({ path: join(runDir, 'lightbox.png') })
  screenshots.push(join(runDir, 'lightbox.png'))

  check('ui D leaves no renderer console errors', consoleErrors.length === 0, consoleErrors)
  check('ui D leaves no renderer page errors', pageErrors.length === 0, pageErrors)
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
