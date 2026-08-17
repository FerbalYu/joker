import { chromium } from 'playwright-core'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { createHash } from 'node:crypto'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const runDir = await mkdtemp(join(tmpdir(), 'joker-electron-approval-'))
const home = join(runDir, 'home')
const electronUserData = join(runDir, 'electron-user-data')
const mcpFixture = join(runDir, 'mcp-stdio-fixture.mjs')
const logPath = join(runDir, 'fake-provider.log')
const reportPath = join(runDir, 'report.json')
const providerPort = 19765 + Math.floor(Math.random() * 500)
const cdpPort = 20200 + Math.floor(Math.random() * 500)
const checks = []
const screenshots = []
let failure = null
let electron
let browser
let provider
let providerOutput = []
let electronOutput = []

function check(name, value, details = undefined) {
  const result = { name, pass: Boolean(value), ...(details ? { details } : {}) }
  checks.push(result)
  if (!result.pass) throw new Error(`Electron approval smoke failed: ${name}`)
}

async function waitFor(predicate, timeoutMs = 10_000, description = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
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
  try { return parseProviderLog(await readFile(logPath, 'utf8')) } catch { return [] }
}

async function launchElectron() {
  electronOutput = []
  electron = spawn(resolve(root, 'node_modules/electron/dist/electron.exe'), [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${electronUserData}`,
    resolve(root, 'out/main/index.js')
  ], {
    cwd: root,
    env: {
      ...process.env,
      JOKER_HOME: home,
      JOKER_E2E_MULTIWINDOW: '1',
      ELECTRON_ENABLE_LOGGING: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  const onData = (chunk) => electronOutput.push(String(chunk))
  electron.stdout.on('data', onData)
  electron.stderr.on('data', onData)
  const ws = await new Promise((resolve, reject) => {
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
  browser = await chromium.connectOverCDP(ws)
  const context = browser.contexts()[0]
  await waitFor(() => context.pages().length >= 2, 20_000, 'two Electron renderer windows')
  return context.pages()
}

async function installApprovalCapture(page) {
  await page.evaluate(() => {
    window.__jokerQaApprovalRequests = []
    window.joker.approval.onRequest((request) => {
      window.__jokerQaApprovalRequests.push(request)
    })
  })
}

async function sendWritePrompt(page) {
  const textarea = page.locator('textarea').first()
  await textarea.fill('write approval')
  await textarea.press('Enter')
  await page.waitForFunction(() => Array.isArray(window.__jokerQaApprovalRequests) && window.__jokerQaApprovalRequests.length > 0, undefined, { timeout: 20_000 })
  return page.evaluate(() => window.__jokerQaApprovalRequests.at(-1))
}

try {
  provider = spawn(process.execPath, [join(root, 'scripts', 'fixtures', 'fake-provider.mjs')], {
    cwd: root,
    env: { ...process.env, PORT: String(providerPort), LOG_PATH: logPath },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
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
      if (code !== 0) reject(new Error(`Fake Provider exited before ready: ${code}/${signal}; ${providerOutput.join('')}`))
    })
  })
  await providerReady

  await mkdir(join(home, '.joker'), { recursive: true })
  const skillsRoot = join(home, '.joker', 'skills', 'qa-skill')
  await mkdir(skillsRoot, { recursive: true })
  await writeFile(join(skillsRoot, 'SKILL.md'), `---\nid: qa-skill\nname: QA Skill\ndescription: deterministic QA skill\nallowedMcpTools: qa-mcp/echo\n---\nAlways describe the QA capability before using it.\n`)
  const mcpScript = `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'\nimport { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'\nimport { z } from 'zod'\nconst server = new McpServer({ name: 'qa-mcp', version: '1.0.0' })\nserver.registerTool('echo', { description: 'QA echo', inputSchema: { message: z.string() } }, async ({ message }) => ({ content: [{ type: 'text', text: message }] }))\nawait server.connect(new StdioServerTransport())\n`
  await writeFile(mcpFixture, mcpScript)
  const mcpArgs = ['--input-type=module', '-e', mcpScript]
  const trustedFingerprint = createHash('sha256').update(JSON.stringify({
    transport: 'stdio', command: process.execPath.trim(), args: mcpArgs.map((arg) => arg.trim())
  })).digest('hex').slice(0, 32)
  await writeFile(join(home, '.joker', 'config.json'), JSON.stringify({
    providers: [{
      id: 'qa-provider', name: 'QA Provider', type: 'openai-compatible', apiFormat: 'chat-completions',
      baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'qa-key',
      models: [{ id: 'gpt-4o', name: 'gpt-4o', enabled: true }], currentModelId: 'gpt-4o', enabled: true
    }],
    activeProviderId: 'qa-provider', mcpServers: [{
      id: 'qa-mcp', name: 'QA MCP', enabled: true, transport: 'stdio', command: process.execPath,
      args: mcpArgs, autoConnect: true, trustState: 'trusted', trustedFingerprint, permission: 'allow'
    }], disabledSkills: []
  }, null, 2))

  const pages = await launchElectron()
  const pageA = pages[0]
  const pageB = pages[1]
  await Promise.all(pages.map(async (page) => {
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => Boolean(window.joker?.session?.list))
    await waitFor(async () => (await page.evaluate(() => window.joker.session.list())).length > 0, 20_000, 'initial session in renderer')
    await installApprovalCapture(page)
  }))
  await pageB.getByRole('button', { name: '新建对话', exact: true }).click()
  await waitFor(async () => (await pageB.evaluate(() => window.joker.session.list())).length >= 2, 20_000, 'distinct session for window B')
  await pageB.locator('[data-session-id] [aria-current="page"]').waitFor({ state: 'attached', timeout: 30_000 })
  check('MCP server restored and connected in both windows', (await pageA.evaluate(() => window.joker.mcp.list())).some((server) => server.id === 'qa-mcp' && server.status === 'connected'))
  check('MCP tool is discoverable through preload', (await pageA.evaluate(() => window.joker.mcp.tools())).some((entry) => entry.serverId === 'qa-mcp' && entry.tool.name === 'echo'))
  check('QA Skill is discovered through isolated user home', (await pageA.evaluate(() => window.joker.skill.list())).some((skill) => skill.id === 'qa-skill'))
  check('QA Skill can be enabled through Settings API', await pageA.evaluate(() => window.joker.skill.enable('qa-skill')))
  check('enabled QA Skill persists in isolated config', (await pageA.evaluate(() => window.joker.skill.list())).some((skill) => skill.id === 'qa-skill' && skill.enabled))
  const settingsButton = pageA.getByRole('button', { name: /设置|Settings/ }).first()
  await settingsButton.click()
  await pageA.getByRole('button', { name: /MCP/ }).click()
  check('Settings MCP tab renders connected server', (await pageA.locator('body').innerText()).includes('QA MCP'))
  await pageA.getByRole('button', { name: 'Skills', exact: true }).click()
  check('Settings Skills tab renders QA Skill', (await pageA.locator('body').innerText()).includes('QA Skill'))
  await pageA.getByRole('button', { name: /关闭设置|Close settings/ }).click()
  await pageA.locator('textarea').first().fill('read package.json')
  await pageA.locator('textarea').first().press('Enter')
  await pageA.waitForFunction(() => Array.isArray(window.__jokerQaApprovalRequests), undefined, { timeout: 20_000 })
  check('post-settings tool-call flow reaches the renderer', await pageA.locator('body').innerText().then((text) => text.includes('read package.json')))
  check('two renderer windows booted', pages.length >= 2, { pageCount: pages.length })
  check('two windows expose distinct approval-capable renderers', pageA !== pageB)
  await screenshot(pageA, 'window-a-before-approval')
  await screenshot(pageB, 'window-b-before-approval')

  const fullAccessButtonA = pageA.getByRole('button', { name: /完全访问|Full access/ })
  const fullAccessButtonB = pageB.getByRole('button', { name: /完全访问|Full access/ })
  check('window A defaults to full access', await fullAccessButtonA.getAttribute('aria-pressed') === 'true')
  check('window B defaults to full access', await fullAccessButtonB.getAttribute('aria-pressed') === 'true')
  await fullAccessButtonA.click()
  await pageA.getByRole('button', { name: /建议模式|Suggest mode/ }).click()
  await pageB.getByRole('button', { name: /建议模式|Suggest mode/ }).click()
  const approvalA = await sendWritePrompt(pageA)
  const approvalB = await sendWritePrompt(pageB)
  check('window A produces a real approval request', approvalA?.toolName === 'Write', approvalA)
  check('window B produces a real approval request', approvalB?.toolName === 'Write', approvalB)
  check('approval requests carry distinct window ownership', approvalA.windowId !== approvalB.windowId, { windowA: approvalA.windowId, windowB: approvalB.windowId })
  check('approval requests carry session and run scopes', Boolean(approvalA.sessionId && approvalA.runId && approvalB.sessionId && approvalB.runId))
  check('approval UI is visible in window A', (await pageA.locator('body').innerText()).includes('qa-approval-denied.txt'), { body: (await pageA.locator('body').innerText()).slice(-1200) })
  check('approval UI is visible in window B', (await pageB.locator('body').innerText()).includes('qa-approval-denied.txt'), { body: (await pageB.locator('body').innerText()).slice(-1200) })

  const crossWindowResponse = await pageB.evaluate((request) => window.joker.approval.respond(request.requestId, true, request.sessionId, request.runId), approvalA)
  check('window B cannot resolve window A approval', crossWindowResponse === false, { response: crossWindowResponse })

  const ownWindowResponse = await pageA.evaluate((request) => window.joker.approval.respond(request.requestId, true, request.sessionId, request.runId), approvalA)
  check('window A resolves its own approval', ownWindowResponse === true, { response: ownWindowResponse })
  await waitFor(async () => {
    const entries = await providerEntries()
    return entries.filter((entry) => entry.method === 'POST' && entry.url === '/v1/chat/completions').some((entry) => entry.body?.messages?.some((message) => message.role === 'tool'))
  }, 20_000, 'window A approval result round-trip')
  await screenshot(pageA, 'window-a-approved')

  const beforeClose = await providerEntries()
  const bToolResultCountBeforeClose = beforeClose.filter((entry) => entry.method === 'POST' && entry.url === '/v1/chat/completions' && entry.body?.messages?.some((message) => message.role === 'tool')).length
  const pendingBeforeClose = await pageA.evaluate(() => window.joker.approval.pendingCount())
  check('window B approval remains pending before close', pendingBeforeClose >= 1, { pendingCount: pendingBeforeClose })
  await pageB.close()
  await waitFor(() => browser.contexts()[0].pages().length === 1, 10_000, 'window B to close')
  check('closing window B leaves window A alive', browser.contexts()[0].pages().length === 1)
  await waitFor(async () => (await pageA.evaluate(() => window.joker.approval.pendingCount())) === 0, 10_000, 'window B pending approval to be cancelled')
  check('closing window B cancels its pending approval', await pageA.evaluate(() => window.joker.approval.pendingCount()) === 0)
  const afterClose = await providerEntries()
  const bToolResultCountAfterClose = afterClose.filter((entry) => entry.method === 'POST' && entry.url === '/v1/chat/completions' && entry.body?.messages?.some((message) => message.role === 'tool')).length
  check('closing window B does not execute its denied Write tool', bToolResultCountAfterClose === bToolResultCountBeforeClose, {
    before: bToolResultCountBeforeClose,
    after: bToolResultCountAfterClose,
    evidence: 'fake Provider received no tool-result turn for the closed window'
  })
  await screenshot(pageA, 'window-a-after-window-b-close')
} catch (error) {
  failure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) }
} finally {
  if (browser) await browser.close().catch(() => undefined)
  await stopProcess(electron)
  await stopProcess(provider)
  const report = {
    generatedAt: new Date().toISOString(),
    runDir,
    checks,
    screenshots,
    failure,
    providerOutput,
    electronOutput,
    providerLog: await providerEntries(),
    providerExitCode: provider?.exitCode ?? null,
    electronExitCode: electron?.exitCode ?? null
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ reportPath, runDir, checks, screenshots, failure }, null, 2))
  if (failure || checks.some((item) => !item.pass)) process.exitCode = 1
}
