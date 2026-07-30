import { chromium } from 'playwright-core'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { once } from 'node:events'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const runDir = await mkdtemp(join(tmpdir(), 'joker-electron-smoke-'))
const home = join(runDir, 'home')
const electronUserData = join(runDir, 'electron-user-data')
const logPath = join(runDir, 'fake-provider.log')
const reportPath = join(runDir, 'report.json')
const providerPort = 18765 + Math.floor(Math.random() * 500)
const cdpPort = 19200 + Math.floor(Math.random() * 500)
const provider = spawn(process.execPath, [join(root, 'scripts', 'fixtures', 'fake-provider.mjs')], {
  cwd: root,
  env: { ...process.env, PORT: String(providerPort), LOG_PATH: logPath },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
})
const providerOutput = []
const providerReady = new Promise((resolve, reject) => {
  const onData = (chunk) => {
    const text = String(chunk)
    providerOutput.push(text)
    if (text.includes('FAKE_PROVIDER_READY')) resolve()
  }
  provider.stdout.on('data', onData)
  provider.stderr.on('data', onData)
  provider.once('error', reject)
  provider.once('exit', (code, signal) => {
    if (code !== 0) reject(new Error(`Fake Provider exited before ready: code=${code} signal=${signal}; output=${providerOutput.join('')}`))
  })
})

let electron
let browser
let electronOutput = []
const checks = []
const screenshots = []
function check(name, value, details = undefined) {
  checks.push({ name, pass: Boolean(value), ...(details ? { details } : {}) })
  if (!value) throw new Error(`Electron smoke failed: ${name}`)
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
    env: { ...process.env, JOKER_HOME: home, ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  const onData = (chunk) => electronOutput.push(String(chunk))
  electron.stdout.on('data', onData)
  electron.stderr.on('data', onData)
  const endpoint = new Promise((resolve, reject) => {
    const checkEndpoint = () => {
      const match = electronOutput.join('').match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (match) resolve(match[1])
    }
    electron.stdout.on('data', checkEndpoint)
    electron.stderr.on('data', checkEndpoint)
    electron.once('error', reject)
    electron.once('exit', (code, signal) => reject(new Error(`Electron exited before CDP: code=${code} signal=${signal}; output=${electronOutput.join('')}`)))
    setTimeout(() => reject(new Error(`Electron did not expose CDP endpoint: ${electronOutput.join('')}`)), 20_000)
  })
  const ws = await endpoint
  const connectedBrowser = await chromium.connectOverCDP(ws)
  const context = connectedBrowser.contexts()[0]
  const page = context.pages()[0]
  return { browser: connectedBrowser, page }
}

try {
  await providerReady
  await mkdir(home, { recursive: true })
  const configDir = join(home, '.joker')
  await mkdir(configDir, { recursive: true })
  await writeFile(join(configDir, 'config.json'), JSON.stringify({
    providers: [{ id: 'qa-provider', name: 'QA Provider', type: 'openai-compatible', apiFormat: 'chat-completions', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'qa-key', models: [{ id: 'gpt-4o', name: 'gpt-4o', enabled: true }], currentModelId: 'gpt-4o', enabled: true }],
    activeProviderId: 'qa-provider',
    mcpServers: [],
    skills: [],
    approvalMode: 'suggest'
  }, null, 2))

  const first = await launchElectron()
  browser = first.browser
  let page = first.page
  electron = electron
  check('electron exposes remote debugging endpoint', true)
  check('renderer page booted', Boolean(page))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForSelector('textarea')
  await page.locator('textarea').fill('Cold-start stream regression')
  await page.locator('textarea').press('Enter')
  await page.waitForFunction(() => document.body.innerText.includes('Fake Provider is online.'), undefined, { timeout: 30_000 })
  check('cold-start textarea send reaches provider and renders assistant reply', true)
  const providerRequests = (await readFile(logPath, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  check('cold-start send creates provider POST', providerRequests.some((entry) => entry.method === 'POST' && entry.url === '/v1/chat/completions'))
  await screenshot(page, 'cold-start-reply')
  await screenshot(page, 'boot')
  check('JOKER title rendered', await page.locator('body').innerText().then((text) => text.includes('JOKER') || text.includes('New conversation')))

  const config = await page.evaluate(() => window.joker.config.get())
  check('preload config API responds', config.providers?.[0]?.name === 'QA Provider')
  const saved = await page.evaluate(async () => {
    const current = await window.joker.config.get()
    return window.joker.config.save({
      ...current,
      providers: current.providers.map((provider, index) => index === 0 ? { ...provider, name: 'QA Provider Saved' } : provider)
    })
  })
  check('settings save succeeds through preload', saved === true)
  const session = await page.evaluate(() => window.joker.session.create('Electron smoke session'))
  check('session created through preload', Boolean(session.id))
  const sessions = await page.evaluate(() => window.joker.session.list())
  check('session persisted in isolated home', sessions.some((item) => item.id === session.id))
  await screenshot(page, 'session')

  await browser.close()
  browser = undefined
  await stopProcess(electron)
  electron = undefined

  const restarted = await launchElectron()
  browser = restarted.browser
  page = restarted.page
  await page.waitForLoadState('domcontentloaded')
  const restoredConfig = await page.evaluate(() => window.joker.config.get())
  check('settings survive Electron restart', restoredConfig.providers?.[0]?.name === 'QA Provider Saved')
  const restoredSessions = await page.evaluate(() => window.joker.session.list())
  check('sessions survive Electron restart', restoredSessions.some((item) => item.id === session.id))
  await screenshot(page, 'restart')
} finally {
  if (browser) await browser.close().catch(() => undefined)
  await stopProcess(electron)
  await stopProcess(provider)
  const report = {
    generatedAt: new Date().toISOString(),
    runDir,
    checks,
    screenshots,
    providerOutput,
    electronOutput,
    providerExitCode: provider.exitCode,
    electronExitCode: electron?.exitCode ?? null
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  if (checks.some((item) => !item.pass)) process.exitCode = 1
  console.log(JSON.stringify({ reportPath, runDir, checks, screenshots }, null, 2))
}
