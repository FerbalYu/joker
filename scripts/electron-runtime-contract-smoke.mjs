// Real-chain verification for the two remaining risk items from the M6 push:
// 1. fs-optimistic-concurrency: a real Electron session drives Read -> stale
//    Write(expectedVersion) -> rejected -> Read -> Edit(expectedVersion) -> applied,
//    proving the phase-A boundary over the shipped bundle, real IPC and ToolCard path.
// 2. invoke-fallback: a model that only describes tool calls in prose still gets a
//    real, observable tool execution through the fallback path on the shipped bundle.
import { chromium } from 'playwright-core'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { once } from 'node:events'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const runDir = process.env.JOKER_RUNTIME_CONTRACT_RUN_DIR
  ? resolve(process.env.JOKER_RUNTIME_CONTRACT_RUN_DIR)
  : await mkdtemp(join(tmpdir(), 'joker-electron-runtime-contract-'))
await mkdir(runDir, { recursive: true })
const reportPath = join(runDir, 'report.json')
const checks = []
const screenshots = []
const phases = []

function check(phase, name, value, details = undefined) {
  const result = { phase, name, pass: Boolean(value), ...(details === undefined ? {} : { details }) }
  checks.push(result)
  if (!result.pass) throw new Error(`Runtime contract smoke failed: ${name}`)
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* best effort */ }
  } else {
    child.kill('SIGTERM')
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))])
    if (child.exitCode !== null === false) child.kill('SIGKILL')
  }
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
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  throw new Error(`Timed out waiting for ${description}${lastError instanceof Error ? `: ${lastError.message}` : ''}`)
}

async function runPhase({ scenario, seedFiles, drive }) {
  const phaseDir = await mkdtemp(join(runDir, `${scenario}-`))
  const home = join(phaseDir, 'home')
  const project = join(phaseDir, 'project')
  const logPath = join(phaseDir, 'fake-provider.log')
  const providerPort = 24200 + Math.floor(Math.random() * 400)
  const cdpPort = 24700 + Math.floor(Math.random() * 400)
  let provider
  let electron
  let browser
  const consoleErrors = []
  const pageErrors = []
  let providerOutput = []
  let electronOutput = []
  try {
    provider = spawn(process.execPath, [join(root, 'scripts', 'fixtures', 'fake-provider.mjs')], {
      cwd: root,
      env: { ...process.env, PORT: String(providerPort), LOG_PATH: logPath, JOKER_FAKE_SCENARIO: scenario },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
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
    await mkdir(project, { recursive: true })
    for (const [name, content] of Object.entries(seedFiles ?? {})) {
      await writeFile(join(project, name), content, 'utf8')
    }
    await writeFile(join(home, '.joker', 'config.json'), JSON.stringify({
      providers: [{
        id: 'qa-provider',
        name: 'QA Runtime Contract Provider',
        type: 'openai-compatible',
        apiFormat: 'chat-completions',
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        apiKey: 'qa-runtime-key',
        models: [{ id: 'gpt-4o', name: 'gpt-4o', enabled: true, maxContextTokens: 262144 }],
        currentModelId: 'gpt-4o',
        enabled: true,
        promptCache: false
      }],
      activeProviderId: 'qa-provider',
      mcpServers: [],
      disabledSkills: []
    }, null, 2))
    await writeFile(join(home, '.joker', 'projects.json'), JSON.stringify({
      projects: [{ id: 'runtime-contract-workspace', name: 'Runtime Contract', path: project, lastUsedAt: Date.now() }],
      activeProjectId: 'runtime-contract-workspace'
    }, null, 2))

    electron = spawn(resolve(root, 'node_modules/electron/dist/electron.exe'), [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${join(phaseDir, 'electron-user-data')}`,
      resolve(root, 'out/main/index.js')
    ], {
      cwd: root,
      env: { ...process.env, HOME: home, USERPROFILE: home, JOKER_HOME: home, ELECTRON_ENABLE_LOGGING: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    const onElectronData = (chunk) => electronOutput.push(String(chunk))
    electron.stdout.on('data', onElectronData)
    electron.stderr.on('data', onElectronData)
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
      electron.once('exit', (code, signal) => finish(reject, new Error(`Electron exited before CDP: code=${code} signal=${signal}; output=${electronOutput.join('')}`)))
      const timer = setTimeout(() => finish(reject, new Error(`Electron did not expose CDP endpoint: ${electronOutput.join('')}`)), 20_000)
      inspect()
    })

    browser = await chromium.connectOverCDP(ws)
    const context = browser.contexts()[0]
    await waitFor(() => context.pages().length > 0, 10_000, 'renderer page')
    const page = context.pages()[0]
    page.on('console', (message) => {
      if (message.type() === 'error' && !/ResizeObserver loop|Autofill\.enable|script-src.*default-src.*fallback/i.test(message.text())) {
        consoleErrors.push(message.text())
      }
    })
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => Boolean(window.joker?.session?.list))

    const projectsState = await page.evaluate(() => window.joker.project.get())
    const target = (projectsState.state?.projects ?? []).find((candidate) => candidate.path === project)
    if (target) await page.evaluate((projectId) => window.joker.project.select(projectId), target.id)
    await page.evaluate(() => window.joker.approval.setMode('full-auto'))

    const ctx = {
      page,
      phaseDir,
      home,
      project,
      logPath,
      consoleErrors,
      pageErrors,
      screenshot: async (name) => {
        const path = join(phaseDir, `${name}.png`)
        await page.screenshot({ path })
        screenshots.push(path)
      },
      providerRequests: async () => (await readFile(logPath, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    }
    await drive(ctx, (name, value, details) => check(scenario, name, value, details))
    return { scenario, phaseDir, ok: true, consoleErrors, pageErrors }
  } finally {
    if (browser) await browser.close().catch(() => undefined)
    await stopProcess(electron)
    await stopProcess(provider)
    phases.push({ scenario, phaseDir, providerOutput: providerOutput.join(''), electronOutput: electronOutput.join('') })
  }
}

  let failure = null
try {
  await runPhase({
    scenario: 'fs-optimistic-concurrency',
    seedFiles: { 'notes.txt': 'stable initial content\n' },
    drive: async ({ page, project, screenshot, providerRequests, consoleErrors, pageErrors }, check) => {
      await waitFor(async () => (await page.evaluate(() => window.joker.session.list())).length > 0, 20_000, 'initial session')
      const sessions = await page.evaluate(() => window.joker.session.list())
      const activeProjectId = (await page.evaluate(() => window.joker.project.get())).state?.activeProjectId
      const bound = await page.evaluate(({ sessionId, projectId }) => window.joker.session.setProject(sessionId, projectId), { sessionId: sessions[0]?.id, projectId: activeProjectId })
      check('session is bound to the seeded workspace project', Boolean(bound) && Boolean(activeProjectId))
      const textarea = page.locator('textarea').first()
      await textarea.fill('Use expectedVersion to update notes.txt safely.')
      await textarea.press('Enter')
      await page.waitForFunction(() => document.body.innerText.includes('FS_OCC_OK'), undefined, { timeout: 60_000 })

      const requests = await providerRequests()
      const allMessages = requests.flatMap((entry) => entry.body?.messages ?? [])
      const assistantCalls = allMessages.filter((message) => Array.isArray(message.tool_calls)).flatMap((message) => message.tool_calls.map((call) => ({ id: call.id, name: call.function?.name, args: call.function?.arguments })))
      const staleWrite = assistantCalls.find((call) => call.id === 'call_fs_occ_write_stale')
      check('model issued the stale Write with a wrong expectedVersion', Boolean(staleWrite) && String(staleWrite.args).includes('"expectedVersion"') && !String(staleWrite.args).includes('0000000000000000000000000000000000000000000000000000000000000000'), staleWrite?.args)
      const versionedEdit = assistantCalls.find((call) => call.id === 'call_fs_occ_edit')
      check('model re-read and issued Edit with the fresh digest', Boolean(versionedEdit) && /[0-9a-f]{64}/.test(String(versionedEdit.args)) && !String(versionedEdit.args).includes('0000'), versionedEdit?.args)

      const toolResults = allMessages.filter((message) => message.role === 'tool')
      const contentOf = (message) => {
        const raw = String(message?.content ?? '')
        try {
          const parsed = JSON.parse(raw)
          return typeof parsed?.output === 'string' ? parsed.output : raw
        } catch {
          return raw
        }
      }
      const staleWriteResult = toolResults.find((message) => message.tool_call_id === 'call_fs_occ_write_stale')
      check('stale Write tool result reports the version mismatch', contentOf(staleWriteResult).includes('expectedVersion mismatch'), contentOf(staleWriteResult))
      const editResult = toolResults.find((message) => message.tool_call_id === 'call_fs_occ_edit')
      check('versioned Edit tool result reports success', contentOf(editResult).includes('Edited notes.txt'), contentOf(editResult))

      const persisted = await readFile(join(project, 'notes.txt'), 'utf8')
      check('workspace file holds the edited content, not the stale overwrite', persisted.includes('edited with expectedVersion') && !persisted.includes('colliding overwrite'), persisted)
      check('chat renders the tool workflow and the final reply', await page.locator('body').innerText().then((text) => text.includes('FS_OCC_OK')) && await page.locator('[data-tool-call-group]').count() >= 1)
      check('fs-occ phase leaves no renderer console errors', consoleErrors.length === 0, consoleErrors)
      check('fs-occ phase leaves no renderer page errors', pageErrors.length === 0, pageErrors)
      await screenshot('fs-occ-complete')
    }
  })

  await runPhase({
    scenario: 'tool-repeat-reminder',
    seedFiles: { 'repeat.txt': 'stable repeated tool result\n' },
    drive: async ({ page, screenshot, providerRequests, consoleErrors, pageErrors }, check) => {
      await waitFor(async () => (await page.evaluate(() => window.joker.session.list())).length > 0, 20_000, 'initial session')
      const sessions = await page.evaluate(() => window.joker.session.list())
      const projectId = (await page.evaluate(() => window.joker.project.get())).state?.activeProjectId
      const bound = await page.evaluate(({ sessionId, projectId }) => window.joker.session.setProject(sessionId, projectId), { sessionId: sessions[0]?.id, projectId })
      check('tool-repeat session is bound to the seeded workspace', Boolean(bound))
      const textarea = page.locator('textarea').first()
      await textarea.fill('Read repeat.txt until the provider finishes.')
      await textarea.press('Enter')
      await page.waitForFunction(() => document.body.innerText.includes('TOOL_REPEAT_OK'), undefined, { timeout: 60_000 })

      const requests = await providerRequests()
      const allCalls = requests.flatMap((entry) => entry.body?.messages ?? []).filter((message) => message?.role === 'assistant' && Array.isArray(message.tool_calls)).flatMap((message) => message.tool_calls).filter((call) => call?.function?.name === 'Read')
      const repeatCalls = [...new Map(allCalls.map((call) => [call.id, call])).values()]
      check('provider executed three repeated Read calls', repeatCalls.length === 3 && repeatCalls.map((call) => call.id).sort().join(',') === 'call_tool_repeat_1,call_tool_repeat_2,call_tool_repeat_3', repeatCalls.map((call) => call.id))
      const allToolResults = requests.flatMap((entry) => entry.body?.messages ?? []).filter((message) => message?.role === 'tool')
      const resultIds = new Set(allToolResults.map((message) => message.tool_call_id))
      check('all three repeated Read calls returned tool results', repeatCalls.every((call) => resultIds.has(call.id)), [...resultIds])
      const lastRequestMessages = requests.at(-1)?.body?.messages ?? []
      check('fourth provider request receives the advisory reminder', lastRequestMessages.some((message) => message?.role === 'user' && String(message.content ?? '').includes('repeating the exact same tool call with identical arguments')))
      check('repeated Read ToolCards remain visible', await page.locator('[data-tool-call-group]').count() >= 1)
      check('tool-repeat phase leaves no renderer console errors', consoleErrors.length === 0, consoleErrors)
      check('tool-repeat phase leaves no renderer page errors', pageErrors.length === 0, pageErrors)
      await screenshot('tool-repeat-complete')
    }
  })

  await runPhase({
    scenario: 'invoke-fallback',
    seedFiles: { 'package.json': '{\n  "name": "joker-runtime-contract-fixture",\n  "version": "0.0.1",\n  "private": true\n}\n' },
    drive: async ({ page, home, project, screenshot, providerRequests, consoleErrors, pageErrors }, check) => {
      await waitFor(async () => (await page.evaluate(() => window.joker.session.list())).length > 0, 20_000, 'initial session')
      const sessions = await page.evaluate(() => window.joker.session.list())
      const bound = await page.evaluate(({ sessionId, projectId }) => window.joker.session.setProject(sessionId, projectId), { sessionId: sessions[0]?.id, projectId: (await page.evaluate(() => window.joker.project.get())).state?.activeProjectId })
      check('session is bound to the seeded workspace project', Boolean(bound))
      const textarea = page.locator('textarea').first()
      await textarea.fill('Describe the tools in prose instead of calling them.')
      await textarea.press('Enter')
      await page.waitForFunction(() => document.body.innerText.includes('INVOKE_FALLBACK_OK'), undefined, { timeout: 60_000 })

      const requests = await providerRequests()
      const allMessages = requests.flatMap((entry) => entry.body?.messages ?? [])
      const toolResults = allMessages.filter((message) => message.role === 'tool')
      const contentOf = (message) => {
        const raw = String(message?.content ?? '')
        try {
          const parsed = JSON.parse(raw)
          return typeof parsed?.output === 'string' ? parsed.output : raw
        } catch {
          return raw
        }
      }
      check('prose TodoWrite became a real executed tool call with a rendered result', toolResults.some((message) => contentOf(message).includes('Todo list updated')), toolResults.map(contentOf))
      check('prose Read became a real executed tool call with file content', toolResults.some((message) => contentOf(message).includes('"name"') || contentOf(message).includes('joker')), toolResults.map(contentOf))

      const sessionFiles = (await readdir(join(home, '.joker', 'sessions'))).filter((name) => name.endsWith('.json'))
      let persistedTools = []
      let persistedSegments = []
      for (const name of sessionFiles) {
        const envelope = JSON.parse(await readFile(join(home, '.joker', 'sessions', name), 'utf8'))
        for (const message of envelope.data?.messages ?? []) {
          persistedTools = [...persistedTools, ...(message.toolCalls ?? [])]
          for (const segment of message.segments ?? []) {
            if (segment.type === 'tools') persistedSegments = [...persistedSegments, ...segment.tools]
          }
        }
      }
      const effectiveTools = persistedTools.length > 0 ? persistedTools : persistedSegments
      check('session history persists the fallback-executed tool calls', effectiveTools.length >= 2 && effectiveTools.every((tool) => tool.status === 'done' || tool.status === 'error'), effectiveTools.map((tool) => ({ name: tool.toolName, status: tool.status })))
      check('fallback tool calls are visible in the chat transcript', await page.locator('body').innerText().then((text) => text.includes('TodoWrite') || text.includes('待办') || text.includes('invoke fallback durable tool call')))
      check('invoke-fallback phase leaves no renderer console errors', consoleErrors.length === 0, consoleErrors)
      check('invoke-fallback phase leaves no renderer page errors', pageErrors.length === 0, pageErrors)
      await screenshot('invoke-fallback-complete')
    }
  })
} catch (error) {
  failure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) }
} finally {
  const report = {
    generatedAt: new Date().toISOString(),
    runDir,
    phases,
    checks,
    screenshots,
    failure
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ reportPath, runDir, checks, screenshots, failure }, null, 2))
  if (failure || checks.some((item) => !item.pass)) process.exitCode = 1
}
