import { chromium } from 'playwright-core'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { once } from 'node:events'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const runDir = await mkdtemp(join(tmpdir(), 'joker-electron-mcp-settings-'))
const home = join(runDir, 'home')
const userData = join(runDir, 'electron-user-data')
const fixturePath = join(runDir, 'mcp-fixture.mjs')
const reportPath = join(runDir, 'report.json')
const fixtureImport = pathToFileURL(fixturePath).href
const sdkRoot = join(root, 'node_modules/@modelcontextprotocol/sdk/dist/esm')
const zodPath = join(root, 'node_modules/zod/index.js')
const checks = []
const screenshots = []
let electron
let browser
let failure = null
let output = ''

function check(name, pass, details = undefined) {
  const result = { name, pass: Boolean(pass), ...(details === undefined ? {} : { details }) }
  checks.push(result)
  if (!result.pass) throw new Error(`Electron MCP Settings qualification failed: ${name}`)
}

async function waitFor(predicate, timeoutMs = 15_000, description = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error(`Timed out waiting for ${description}`)
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
    await Promise.race([once(child, 'exit'), new Promise((resolveWait) => setTimeout(resolveWait, 5000))])
    if (child.exitCode === null) child.kill('SIGKILL')
  }
}

function electronExecutable() {
  return join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
}

async function launchElectron() {
  output = ''
  electron = spawn(electronExecutable(), [
    `--remote-debugging-port=${19000 + Math.floor(Math.random() * 800)}`,
    `--user-data-dir=${userData}`,
    resolve(root, 'out/main/index.js')
  ], {
    cwd: root,
    env: { ...process.env, JOKER_HOME: home, ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  const onData = (chunk) => { output += String(chunk) }
  electron.stdout?.on('data', onData)
  electron.stderr?.on('data', onData)
  const ws = await new Promise((resolveWs, reject) => {
    const findEndpoint = () => {
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (match) resolveWs(match[1])
    }
    electron.stdout?.on('data', findEndpoint)
    electron.stderr?.on('data', findEndpoint)
    electron.once('error', reject)
    electron.once('exit', (code, signal) => reject(new Error(`Electron exited before CDP: ${code}/${signal}\n${output}`)))
    setTimeout(() => reject(new Error(`Electron did not expose CDP\n${output}`)), 20_000)
  })
  browser = await chromium.connectOverCDP(ws)
  const page = browser.contexts()[0]?.pages()[0]
  if (!page) throw new Error('Electron renderer page was not created')
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.joker?.mcp?.list))
  return page
}

await mkdir(join(home, '.joker'), { recursive: true })
await writeFile(fixturePath, `
import { McpServer } from '${pathToFileURL(join(sdkRoot, 'server/mcp.js')).href}'
import { StdioServerTransport } from '${pathToFileURL(join(sdkRoot, 'server/stdio.js')).href}'
import { z } from '${pathToFileURL(zodPath).href}'
const server = new McpServer({ name: 'joker-settings-fixture', version: '1.0.0' })
server.registerTool('echo', { description: 'Settings UI echo tool', inputSchema: { message: z.string() } }, async ({ message }) => ({ content: [{ type: 'text', text: message }] }))
await server.connect(new StdioServerTransport())
`, 'utf8')

const mcpArgs = ['--input-type=module', '-e', `import(${JSON.stringify(fixtureImport)})`]
await writeFile(join(home, '.joker', 'config.json'), JSON.stringify({
  providers: [{
    id: 'qa-provider', name: 'QA Provider', type: 'openai-compatible', apiFormat: 'chat-completions',
    baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'qa-key',
    models: [{ id: 'gpt-4o', name: 'gpt-4o', enabled: true }], currentModelId: 'gpt-4o', enabled: true
  }],
  activeProviderId: 'qa-provider',
  mcpServers: [{
    id: 'settings-mcp', name: 'Settings MCP', enabled: true, transport: 'stdio',
    command: process.execPath, args: mcpArgs, autoConnect: true,
    trustState: 'untrusted', permission: 'deny'
  }],
  disabledSkills: []
}, null, 2))

try {
  let page = await launchElectron()
  const settingsButton = page.getByRole('button', { name: /设置|Settings/ }).first()
  await settingsButton.click()
  await page.getByRole('button', { name: /MCP/ }).click()
  const trustButton = page.getByTestId('mcp-trust-settings-mcp')
  const permissionButton = page.getByTestId('mcp-permission-settings-mcp')
  const reconnectButton = page.getByTestId('mcp-reconnect-settings-mcp')
  check('Settings MCP card renders', await page.getByText('Settings MCP', { exact: true }).count() === 1)
  check('initial runtime is untrusted and denied', await page.evaluate(() => {
    const server = window.joker.mcp.list().then((items) => items.find((item) => item.id === 'settings-mcp'))
    return server.then((item) => item?.trustState === 'untrusted' && item.permission === 'deny' && item.status !== 'connected')
  }))
  check('trust control is available and permission is disabled before trust', await trustButton.isEnabled() && await permissionButton.isDisabled())
  await trustButton.click()
  await waitFor(async () => (await page.evaluate(() => window.joker.mcp.list())).find((item) => item.id === 'settings-mcp')?.trustState === 'trusted', 10_000, 'trust state to become trusted')
  check('Trust button updates persisted runtime state', await page.evaluate(() => window.joker.mcp.list()).then((items) => items.find((item) => item.id === 'settings-mcp')?.trustedFingerprint !== undefined))
  await permissionButton.click()
  await waitFor(async () => (await page.evaluate(() => window.joker.mcp.list())).find((item) => item.id === 'settings-mcp')?.permission === 'allow', 10_000, 'permission to become allowed')
  check('Allow control updates server permission', (await page.evaluate(() => window.joker.mcp.list())).find((item) => item.id === 'settings-mcp')?.permission === 'allow')
  await reconnectButton.click()
  await waitFor(async () => (await page.evaluate(() => window.joker.mcp.list())).find((item) => item.id === 'settings-mcp')?.status === 'connected', 20_000, 'MCP server to connect')
  check('Reconnect connects the trusted allowed server', (await page.evaluate(() => window.joker.mcp.list())).find((item) => item.id === 'settings-mcp')?.toolCount === 1)
  check('connected MCP tool is exposed through preload', (await page.evaluate(() => window.joker.mcp.tools())).some((item) => item.serverId === 'settings-mcp' && item.tool.name === 'echo'))
  await screenshot(page, 'trusted-allowed-connected')

  await trustButton.click()
  await waitFor(async () => {
    const item = (await page.evaluate(() => window.joker.mcp.list())).find((server) => server.id === 'settings-mcp')
    return item?.trustState === 'untrusted' && item.status === 'disconnected' && item.toolCount === 0
  }, 10_000, 'trust to be revoked')
  check('Revoke trust disconnects and removes MCP tools', !(await page.evaluate(() => window.joker.mcp.tools())).some((item) => item.serverId === 'settings-mcp'))
  await screenshot(page, 'trust-revoked')

  await trustButton.click()
  await waitFor(async () => (await page.evaluate(() => window.joker.mcp.list())).find((item) => item.id === 'settings-mcp')?.trustState === 'trusted', 10_000, 'trust to be restored')
  const restoredPolicy = await page.evaluate(() => window.joker.mcp.list()).then((items) => items.find((item) => item.id === 'settings-mcp'))
  if (restoredPolicy?.permission !== 'allow') {
    await permissionButton.click()
    await waitFor(async () => (await page.evaluate(() => window.joker.mcp.list())).find((item) => item.id === 'settings-mcp')?.permission === 'allow', 10_000, 'permission to be restored')
  }
  await reconnectButton.click()
  await waitFor(async () => (await page.evaluate(() => window.joker.mcp.list())).find((item) => item.id === 'settings-mcp')?.status === 'connected', 20_000, 'MCP server to reconnect')
  await permissionButton.click()
  await waitFor(async () => {
    const item = (await page.evaluate(() => window.joker.mcp.list())).find((server) => server.id === 'settings-mcp')
    return item?.permission === 'deny' && item.status === 'disconnected' && item.toolCount === 0
  }, 10_000, 'permission to be denied')
  check('Deny disconnects the server and removes tools', !(await page.evaluate(() => window.joker.mcp.tools())).some((item) => item.serverId === 'settings-mcp'))
  await screenshot(page, 'permission-denied')

  await browser.close()
  browser = undefined
  await stopProcess(electron)
  electron = undefined
  page = await launchElectron()
  const restored = await page.evaluate(() => window.joker.mcp.list()).then((items) => items.find((item) => item.id === 'settings-mcp'))
  check('trust and deny permission survive Electron restart', restored?.trustState === 'trusted' && restored.permission === 'deny' && restored.status === 'disconnected')
  check('restart does not auto-connect a denied server', !(await page.evaluate(() => window.joker.mcp.tools())).some((item) => item.serverId === 'settings-mcp'))
  await screenshot(page, 'restart-persisted-policy')
} catch (error) {
  failure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) }
} finally {
  if (browser) await browser.close().catch(() => undefined)
  await stopProcess(electron)
  const report = {
    generatedAt: new Date().toISOString(),
    command: process.argv.slice(1).join(' '),
    platform: process.platform,
    runDir,
    checks,
    screenshots,
    failure,
    electronOutput: output
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ reportPath, runDir, checks, screenshots, failure }, null, 2))
  if (failure || checks.some((item) => !item.pass)) process.exitCode = 1
}
