// Real-chain verification for the UI rearrangement slice:
// 1. reading width cap on the message stream (max-w-3xl),
// 2. compact project row inside the composer + approval modes moved into the provider popover,
// 3. welcome state with model name, pick-folder CTA, and sample prompt chips that fill the input.
import { chromium } from 'playwright-core'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { once } from 'node:events'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const runDir = await mkdtemp(join(tmpdir(), 'joker-electron-ui-slice-'))
const home = join(runDir, 'home')
const logPath = join(runDir, 'fake-provider.log')
const reportPath = join(runDir, 'report.json')
const providerPort = 26200 + Math.floor(Math.random() * 400)
const cdpPort = 26700 + Math.floor(Math.random() * 400)
const checks = []
const screenshots = []
const consoleErrors = []
const pageErrors = []

function check(name, value, details = undefined) {
  const result = { name, pass: Boolean(value), ...(details === undefined ? {} : { details }) }
  checks.push(result)
  if (!result.pass) throw new Error(`UI slice smoke failed: ${name}`)
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

  await mkdir(join(home, '.joker'), { recursive: true })
  await writeFile(join(home, '.joker', 'config.json'), JSON.stringify({
    providers: [{
      id: 'qa-provider',
      name: 'QA UI Provider',
      type: 'openai-compatible',
      apiFormat: 'chat-completions',
      baseUrl: `http://127.0.0.1:${providerPort}/v1`,
      apiKey: 'qa-ui-key',
      models: [{ id: 'gpt-4o', name: 'gpt-4o', enabled: true }],
      currentModelId: 'gpt-4o',
      enabled: true
    }],
    activeProviderId: 'qa-provider',
    mcpServers: [],
    approvalMode: 'suggest'
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
  await page.waitForSelector('textarea')

  // 3. Welcome state on the cold empty session.
  const welcome = page.locator('[data-welcome-state]')
  await welcome.waitFor({ state: 'visible', timeout: 10_000 })
  const welcomeText = await welcome.innerText()
  check('welcome state shows the active provider name', welcomeText.includes('QA UI Provider'), welcomeText)
  check('welcome state offers the pick-folder CTA before a project is bound', await welcome.getByRole('button').filter({ hasText: /选择工作文件夹|working folder/i }).count() === 1)
  const sampleChip = welcome.getByRole('button').filter({ hasText: /解释|架构|Explain/i }).first()
  await sampleChip.click()
  const textarea = page.locator('textarea').first()
  await page.waitForFunction(() => Boolean(document.querySelector('textarea')?.value))
  const filled = await textarea.inputValue()
  check('sample prompt chip fills the composer', filled.length > 0, filled)
  await textarea.fill('')

  await page.screenshot({ path: join(runDir, 'welcome-state.png') })
  screenshots.push(join(runDir, 'welcome-state.png'))

  // 2. Compact project row lives inside the composer.
  const composer = page.locator('[data-input-composer]')
  const composerBox = await composer.boundingBox()
  const projectButton = composer.locator('button').filter({ hasText: /未选择工作文件夹|No working folder/i }).first()
  const projectBox = await projectButton.boundingBox()
  check('project selector renders as a compact row inside the composer', Boolean(composerBox && projectBox && projectBox.y >= composerBox.y && projectBox.y + projectBox.height <= composerBox.y + 36))
  check('project row no longer occupies a full standalone band above the composer', Boolean(composerBox && projectBox && projectBox.width < composerBox.width * 0.6), { composerBox, projectBox })

  // Approval modes moved into the provider popover.
  const providerMenu = page.locator('button').filter({ hasText: /QA UI Provider/ }).first()
  const bottomControls = page.locator('[data-input-composer]').locator('..').locator('> div').last()
  const bottomTextBefore = await bottomControls.innerText()
  check('approval mode icons are no longer in the always-visible control row', !/建议模式|自动编辑|全自动|Suggest mode|Auto-edit mode|Full-auto mode/i.test(bottomTextBefore), bottomTextBefore)
  await providerMenu.click()
  await page.waitForTimeout(300)
  const popoverSuggest = page.locator('button[title="建议模式"], button[title="Suggest mode"]').first()
  const approvalVisible = await popoverSuggest.isVisible().catch(() => false)
  const suggestTitle = await popoverSuggest.getAttribute('title').catch(() => null)
  check('approval modes are reachable inside the provider popover', approvalVisible, { suggestTitle })
  await page.keyboard.press('Escape')

  await page.screenshot({ path: join(runDir, 'composer-rearranged.png') })
  screenshots.push(join(runDir, 'composer-rearranged.png'))

  // 1. Reading width cap: send a message, measure the content column.
  await textarea.fill('width probe')
  await textarea.press('Enter')
  await page.waitForFunction(() => document.body.innerText.includes('Fake Provider is online.'), undefined, { timeout: 30_000 })
  await page.setViewportSize({ width: 1800, height: 1000 })
  await page.waitForTimeout(300)
  const contentWidth = await page.evaluate(() => document.querySelector('[data-message-stream-content]')?.getBoundingClientRect().width ?? 0)
  check('message stream caps the reading width on wide windows', contentWidth <= 48 * 16 + 64, contentWidth)
  const composerWidth = await page.evaluate(() => document.querySelector('[data-input-composer]')?.getBoundingClientRect().width ?? 0)
  check('composer matches the capped conversation width', Math.abs(composerWidth - contentWidth) <= 8, { contentWidth, composerWidth })
  await page.screenshot({ path: join(runDir, 'wide-width-cap.png') })
  screenshots.push(join(runDir, 'wide-width-cap.png'))

  check('ui slice leaves no renderer console errors', consoleErrors.length === 0, consoleErrors)
  check('ui slice leaves no renderer page errors', pageErrors.length === 0, pageErrors)
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
