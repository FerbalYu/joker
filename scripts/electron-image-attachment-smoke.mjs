import { chromium } from 'playwright-core'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { once } from 'node:events'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const runDir = await mkdtemp(join(tmpdir(), 'joker-image-attachment-smoke-'))
const home = join(runDir, 'home')
const electronUserData = join(runDir, 'electron-user-data')
const providerLogPath = join(runDir, 'fake-provider.log')
const reportPath = join(runDir, 'report.json')
const providerPort = 22200 + Math.floor(Math.random() * 400)
const cdpPort = 22700 + Math.floor(Math.random() * 400)
const checks = []
const screenshots = []
const consoleErrors = []
const pageErrors = []
let provider
let electron
let browser
let failure = null

function check(name, value, details) {
  checks.push({ name, pass: Boolean(value), ...(details === undefined ? {} : { details }) })
  if (!value) throw new Error(`Electron image attachment smoke failed: ${name}`)
}

async function screenshot(page, name, locator = null) {
  const path = join(runDir, `${name}.png`)
  if (locator) await locator.screenshot({ path })
  else await page.screenshot({ path })
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

try {
  provider = spawn(process.execPath, [join(root, 'scripts', 'fixtures', 'fake-provider.mjs')], {
    cwd: root,
    env: { ...process.env, PORT: String(providerPort), LOG_PATH: providerLogPath },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  await new Promise((resolveReady, reject) => {
    const onData = (chunk) => {
      if (String(chunk).includes('FAKE_PROVIDER_READY')) resolveReady()
    }
    provider.stdout.on('data', onData)
    provider.stderr.on('data', onData)
    provider.once('error', reject)
    provider.once('exit', (code, signal) => reject(new Error(`Fake Provider exited before ready: ${code}/${signal}`)))
  })

  await mkdir(join(home, '.joker'), { recursive: true })
  await mkdir(electronUserData, { recursive: true })
  await writeFile(join(home, '.joker', 'config.json'), JSON.stringify({
    providers: [{
      id: 'qa-provider',
      name: 'QA Provider',
      type: 'openai-compatible',
      apiFormat: 'chat-completions',
      baseUrl: `http://127.0.0.1:${providerPort}/v1`,
      apiKey: 'qa-key',
      models: [{ id: 'gpt-4o', name: 'gpt-4o', enabled: true }],
      currentModelId: 'gpt-4o',
      enabled: true
    }],
    activeProviderId: 'qa-provider',
    mcpServers: [],
    disabledSkills: []
  }, null, 2))

  const output = []
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
  const onData = (chunk) => output.push(String(chunk))
  electron.stdout.on('data', onData)
  electron.stderr.on('data', onData)
  const ws = await new Promise((resolveWs, reject) => {
    const inspect = () => {
      const match = output.join('').match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (match) resolveWs(match[1])
    }
    electron.stdout.on('data', inspect)
    electron.stderr.on('data', inspect)
    electron.once('error', reject)
    electron.once('exit', (code, signal) => reject(new Error(`Electron exited before CDP: ${code}/${signal}; ${output.join('')}`)))
    setTimeout(() => reject(new Error(`Electron did not expose CDP: ${output.join('')}`)), 20_000)
  })

  browser = await chromium.connectOverCDP(ws)
  const page = browser.contexts()[0].pages()[0]
  page.on('console', (message) => { if (message.type() === 'error' && !/Autofill\.enable|ResizeObserver|script-src.*default-src/i.test(message.text())) consoleErrors.push(message.text()) })
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.joker?.session?.list))
  await page.waitForFunction(() => document.querySelector('textarea') !== null)

  const textarea = page.locator('textarea').first()
  await textarea.evaluate(async (element) => {
    const canvas = document.createElement('canvas')
    canvas.width = 8
    canvas.height = 8
    const context = canvas.getContext('2d')
    context.fillStyle = '#22c55e'
    context.fillRect(0, 0, 8, 8)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('Unable to create smoke image blob')
    const file = new File([blob], 'attachment-smoke.png', { type: 'image/png' })
    const transfer = new DataTransfer()
    transfer.items.add(file)
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: transfer })
    element.dispatchEvent(event)
  })

  const composerAttachment = page.locator('[data-image-preview="thumbnail"]').first()
  await composerAttachment.waitFor({ state: 'visible', timeout: 15_000 })
  const composerBox = await composerAttachment.boundingBox()
  const textareaBox = await textarea.boundingBox()
  check('composer thumbnail remains compact', composerBox && composerBox.width >= 54 && composerBox.width <= 58 && composerBox.height >= 54 && composerBox.height <= 58, composerBox)
  check('composer attachment is above textarea', composerBox && textareaBox && composerBox.y + composerBox.height <= textareaBox.y, { composerBox, textareaBox })
  await textarea.fill('附件在文字上方，发送后仍保持紧凑展示。')
  await screenshot(page, 'composer-attachment', page.locator('[data-input-composer]'))
  await textarea.press('Enter')

  await page.waitForFunction(() => document.querySelector('[data-message-attachments] [data-image-preview="attachment"]') !== null, undefined, { timeout: 20_000 })
  const messageAttachment = page.locator('[data-message-attachments] [data-image-preview="attachment"]').last()
  const messageBox = await messageAttachment.boundingBox()
  const messageText = page.getByText('附件在文字上方，发送后仍保持紧凑展示。', { exact: true }).last()
  const messageTextBox = await messageText.boundingBox()
  check('sent user attachment remains compact', messageBox && messageBox.width >= 54 && messageBox.width <= 58 && messageBox.height >= 54 && messageBox.height <= 58, messageBox)
  check('sent user attachment is above message text', messageBox && messageTextBox && messageBox.y + messageBox.height <= messageTextBox.y, { messageBox, messageTextBox })
  await screenshot(page, 'message-attachment', messageAttachment.locator('xpath=ancestor::div[contains(@class,"group")][1]'))

  await messageAttachment.getByRole('button').click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor({ state: 'visible' })
  check('compact attachment opens full preview', await dialog.isVisible())
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  check('Escape closes full preview', !(await dialog.isVisible()))
  check('renderer has no relevant console errors', consoleErrors.length === 0, consoleErrors)
  check('renderer has no page errors', pageErrors.length === 0, pageErrors)
} catch (error) {
  failure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) }
} finally {
  if (browser) await browser.close().catch(() => undefined)
  await stopProcess(electron)
  await stopProcess(provider)
  const report = { generatedAt: new Date().toISOString(), runDir, checks, screenshots, consoleErrors, pageErrors, failure }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ reportPath, runDir, checks, screenshots, failure }, null, 2))
  if (failure || checks.some((item) => !item.pass)) process.exitCode = 1
}
