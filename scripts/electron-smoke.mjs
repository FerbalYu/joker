import { chromium } from 'playwright-core'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { createHash } from 'node:crypto'

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
const consoleErrors = []
const pageErrors = []
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
    env: { ...process.env, HOME: home, USERPROFILE: home, JOKER_HOME: home, ELECTRON_ENABLE_LOGGING: '1' },
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
  page.on('console', (message) => {
    if (message.type() === 'error' && !/Autofill\.enable|script-src.*default-src.*fallback/i.test(message.text())) consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))
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
  const smokeSkillDir = join(configDir, 'skills', 'smoke-disabled')
  const smokeEnabledSkillDir = join(configDir, 'skills', 'smoke-enabled')
  const smokeDisabledRaw = `---\nid: smoke-disabled\nname: Smoke Disabled\ndescription: Smoke-only disabled Skill\n---\nTest instructions.\n`
  const smokeEnabledRaw = `---\nid: smoke-enabled\nname: Smoke Enabled\ndescription: Smoke-only enabled Skill\n---\nEnabled test instructions.\n`
  await mkdir(smokeSkillDir, { recursive: true })
  await mkdir(smokeEnabledSkillDir, { recursive: true })
  await writeFile(join(smokeSkillDir, 'SKILL.md'), smokeDisabledRaw)
  await writeFile(join(smokeEnabledSkillDir, 'SKILL.md'), smokeEnabledRaw)
  const smokeEnabledFingerprint = createHash('sha256').update('user').update('\0').update('smoke-enabled').update('\0').update(smokeEnabledRaw).digest('hex')
  const smokeConfig = JSON.parse(await readFile(join(configDir, 'config.json'), 'utf8'))
  smokeConfig.trustedSkills = [{ id: 'smoke-enabled', fingerprint: smokeEnabledFingerprint }]
  smokeConfig.skillStateVersion = 1
  await writeFile(join(configDir, 'config.json'), JSON.stringify(smokeConfig, null, 2))

  const first = await launchElectron()
  browser = first.browser
  let page = first.page
  electron = electron
  check('electron exposes remote debugging endpoint', true)
  check('renderer page booted', Boolean(page))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForSelector('textarea')
  const slashTrigger = page.getByRole('button', { name: /打开命令与 Skills|Open commands and Skills/i })
  const textarea = page.locator('textarea').first()
  check('slash+ trigger is accessible in chat mode', await slashTrigger.isVisible() && await slashTrigger.isEnabled())
  await slashTrigger.click()
  const slashMenu = page.locator('[data-slash-menu]')
  await slashMenu.waitFor({ state: 'visible' })
  check('slash+ opens a unified listbox', await slashMenu.getAttribute('role') === 'listbox' && await slashTrigger.getAttribute('aria-expanded') === 'true')
  const nativeOptions = slashMenu.locator('[data-slash-option^="native:"]')
  check('slash menu exposes exactly three native commands in order', JSON.stringify(await nativeOptions.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-slash-option')))) === JSON.stringify(['native:goal', 'native:plan', 'native:compact']))
  const slashText = await slashMenu.innerText()
  check('slash menu omits the erroneous settings palette', !/(^|\n)\/(model|mode|reasoning|approval|project|context|mcp)(?:\s|$)/im.test(slashText), slashText)
  check('native commands are wired and selectable', await nativeOptions.count() === 3 && await nativeOptions.evaluateAll((nodes) => nodes.every((node) => node.getAttribute('aria-disabled') === 'false')), slashText)
  const skillOption = slashMenu.locator('[data-slash-option="skill:smoke-disabled"]')
  check('disabled Skills remain visible with one enablement reason', await skillOption.count() === 1 && await skillOption.getAttribute('aria-disabled') === 'true' && /已停用|disabled/i.test(await skillOption.innerText()))
  const enabledSkillOption = slashMenu.locator('[data-slash-option="skill:smoke-enabled"]')
  check('enabled Skills are selectable without a second trust state', await enabledSkillOption.count() === 1 && await enabledSkillOption.getAttribute('aria-disabled') === 'false' && !/未受信任|untrusted/i.test(await slashMenu.innerText()))
  await textarea.press('Escape')
  await page.getByRole('button', { name: /设置|Settings/i }).click()
  await page.getByRole('button', { name: /^Skills$/ }).click()
  const disabledSkillCard = page.locator('[data-skill-card="smoke-disabled"]')
  check('Settings exposes one Skill state and one action', await disabledSkillCard.locator('[data-testid="skill-enabled-state-smoke-disabled"]').count() === 1 && await disabledSkillCard.locator('[data-testid="skill-toggle-smoke-disabled"]').count() === 1 && await disabledSkillCard.locator('[data-testid^="skill-trust-"]').count() === 0)
  await disabledSkillCard.locator('[data-testid="skill-toggle-smoke-disabled"]').click()
  await page.waitForFunction(() => window.joker.skill.list().then((skills) => skills.some((skill) => skill.id === 'smoke-disabled' && skill.enabled && skill.trusted && skill.trustState === 'trusted')))
  check('enabling a Skill also trusts its current fingerprint', await page.locator('[data-testid="skill-enabled-state-smoke-disabled"]').innerText().then((text) => /已启用|Enabled/i.test(text)))
  await page.locator('[data-testid="skill-toggle-smoke-disabled"]').click()
  await page.waitForFunction(() => window.joker.skill.list().then((skills) => skills.some((skill) => skill.id === 'smoke-disabled' && !skill.enabled && !skill.trusted && skill.trustState === 'untrusted')))
  check('disabling a Skill also revokes its fingerprint record', await page.evaluate(async () => {
    const config = await window.joker.config.get()
    return !(config.trustedSkills ?? []).some((record) => record.id === 'smoke-disabled')
  }))
  await page.getByRole('button', { name: /关闭设置|Close settings/i }).click()
  await slashTrigger.click()
  const options = slashMenu.locator('[role="option"]')
  check('slash menu exposes keyboard-selectable options', await options.count() > 3 && await options.first().getAttribute('aria-selected') === 'true')
  check('slash+ inserts exactly one command token', await textarea.inputValue() === '/')
  await textarea.press('ArrowDown')
  check('arrow navigation updates aria-selected', await options.nth(1).getAttribute('aria-selected') === 'true')
  await skillOption.hover()
  check('pointer hover synchronizes active option', await skillOption.getAttribute('aria-selected') === 'true')
  await textarea.fill('/pla')
  check('typed filtering narrows native commands to plan', await slashMenu.locator('[data-slash-option^="native:"]').count() === 1 && await slashMenu.locator('[data-slash-option="native:plan"]').count() === 1)
  await textarea.press('Escape')
  check('escape closes slash menu without sending', await slashMenu.count() === 0 && await textarea.inputValue() === '/pla')
  await textarea.fill('')
  await slashTrigger.click()
  await page.locator('[data-slash-option="native:goal"]').click()
  check('goal command selection creates a command chip', await page.locator('[data-command-chip="goal"]').count() === 1)
  await textarea.fill('Ship the corrected Slash command flow')
  const requestsBeforeGoal = (await readFile(logPath, 'utf8')).split(/\r?\n/).filter(Boolean).length
  await textarea.press('Enter')
  await page.waitForFunction(() => document.body.innerText.includes('Goal 已保存并开始执行') || document.body.innerText.includes('Goal saved and started'))
  await page.waitForFunction(() => document.body.innerText.includes('Goal evidence: corrected Slash command flow verified in round 2.'), undefined, { timeout: 30_000 })
  await page.locator('[data-goal-card][data-goal-status="completed"]').waitFor({ state: 'visible', timeout: 30_000 })
  const requestsAfterGoal = (await readFile(logPath, 'utf8')).split(/\r?\n/).filter(Boolean).length
  check('goal executes two rounds with independent validation', requestsAfterGoal >= requestsBeforeGoal + 4)
  const activeSession = await page.evaluate(async () => {
    const sessions = await window.joker.session.list()
    return sessions[0] ? window.joker.session.get(sessions[0].id) : null
  })
  check('goal is stored as completed structured state with evaluator usage and no invented token limit', activeSession?.goal?.objective === 'Ship the corrected Slash command flow' && activeSession.goal.status === 'completed' && activeSession.goal.currentRound === 2 && !Object.hasOwn(activeSession.goal, 'tokenLimit') && (activeSession.goal.cumulativeUsage?.totalTokens ?? 0) >= 250 && activeSession.goal.appliedUsageOperations?.some((operation) => operation.phase === 'validation'))
  const goalCardText = await page.locator('[data-goal-card][data-goal-status="completed"]').innerText()
  check('Goal card exposes cumulative usage without an invented limit and keeps the clear action', /已用\s+[\d,]+\s+Token|[\d,]+\s+tokens used/i.test(goalCardText) && !/无上限|Unlimited|1,000,000/i.test(goalCardText) && await page.getByRole('button', { name: /清除 Goal|Clear Goal/i }).count() === 1, goalCardText)

  await slashTrigger.click()
  await page.locator('[data-slash-option="native:plan"]').click()
  check('plan command selection creates a command chip', await page.locator('[data-command-chip="plan"]').count() === 1)
  await textarea.fill('Plan a safe validation change')
  await textarea.press('Enter')
  await page.waitForFunction(() => document.body.innerText.includes('Plan created without implementing changes.'), undefined, { timeout: 30_000 })
  const planRequest = (await readFile(logPath, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).reverse().find((entry) => entry.body?.stream === true && Array.isArray(entry.body?.tools) && entry.body.messages?.some((message) => String(message.content ?? '').includes('Plan a safe validation change')))
  const planTools = planRequest?.body?.tools?.map((tool) => tool?.function?.name).filter(Boolean).sort() ?? []
  check('plan request exposes only the read-only planning tool set', JSON.stringify(planTools) === JSON.stringify(['ContextRetrieve', 'GitDiff', 'GitLog', 'GitStatus', 'Glob', 'Grep', 'Read', 'TodoWrite']))

  const activeSessionId = await page.evaluate(async () => (await window.joker.session.list())[0]?.id ?? null)
  check('active session is available for command smoke', Boolean(activeSessionId))
  const compactHistory = Array.from({ length: 6 }, (_, index) => {
    const role = index % 2 === 0 ? 'user' : 'assistant'
    const marker = role === 'user' ? 'request' : 'response'
    return {
      id: `compact-${index + 1}`,
      role,
      content: `older ${marker} ${String.fromCharCode(97 + index).repeat(5_000)}`,
      createdAt: index + 1
    }
  })
  const compactSeeded = await page.evaluate(async ({ sessionId, history }) => {
    if (!sessionId) return false
    return window.joker.session.replaceMessages(sessionId, history)
  }, { sessionId: activeSessionId, history: compactHistory })
  check('compact smoke seeds long persisted history', compactSeeded)
  const storedBeforeCompact = await page.evaluate(async (sessionId) => sessionId ? window.joker.session.get(sessionId) : null, activeSessionId)
  const compactRequestsBefore = (await readFile(logPath, 'utf8')).split(/\r?\n/).filter(Boolean).length
  await slashTrigger.click()
  await page.locator('[data-slash-option="native:compact"]').click()
  await page.waitForFunction(() => document.body.innerText.includes('上下文已压缩') || document.body.innerText.includes('Context compacted'), undefined, { timeout: 30_000 })
  check('compact command runs without creating a command chip', await page.locator('[data-command-chip="compact"]').count() === 0)
  const storedAfterCompact = await page.evaluate(async (sessionId) => sessionId ? window.joker.session.get(sessionId) : null, activeSessionId)
  check('compact preserves original messages byte-for-byte', JSON.stringify(storedAfterCompact?.messages) === JSON.stringify(storedBeforeCompact?.messages))
  check('compact stores a source-hashed checkpoint', Boolean(storedAfterCompact?.contextCheckpoint?.sourceHash && storedAfterCompact.contextCheckpoint.sourceHash.length === 64))
  const compactRequests = (await readFile(logPath, 'utf8')).split(/\r?\n/).filter(Boolean).slice(compactRequestsBefore).map((line) => JSON.parse(line))
  check('compact invokes a non-streaming structured-summary provider request', compactRequests.some((entry) => entry.body?.stream !== true && entry.body.messages?.some((message) => String(message.content ?? '').includes('Create a durable checkpoint summary of the older conversation history.'))))

  await textarea.fill('')
  await slashTrigger.click()
  await page.locator('[data-slash-option="skill:smoke-enabled"]').click()
  check('selecting an enabled Skill creates a chip and removes it from the menu', await page.locator('[data-input-attachments]').innerText().then((text) => text.includes('/smoke-enabled')) && await slashMenu.count() === 0)
  await slashTrigger.click()
  check('selected Skills are excluded from subsequent menus', await page.locator('[data-slash-option="skill:smoke-enabled"]').count() === 0)
  await textarea.press('Escape')
  await textarea.fill('Skill and goal capability smoke')
  await textarea.press('Enter')
  await page.waitForFunction(() => document.body.innerText.includes('Fake Provider is online.'), undefined, { timeout: 30_000 })
  const capabilityRequest = (await readFile(logPath, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).reverse().find((entry) => entry.body?.stream === true && entry.body.messages?.some((message) => String(message.content ?? '').includes('Skill and goal capability smoke')))
  const capabilitySystemText = capabilityRequest?.body?.messages?.filter((message) => message.role === 'system').map((message) => String(message.content ?? '')).join('\n') ?? ''
  check('ordinary chat is not polluted by the completed Goal', !capabilitySystemText.includes('<GOAL_OBJECTIVE') && !capabilitySystemText.includes('<SESSION_GOAL>'), capabilitySystemText)
  check('enabled Skill instructions reach provider capabilities', capabilitySystemText.includes('## Skill: Smoke Enabled (smoke-enabled)') && capabilitySystemText.includes('Enabled test instructions.'), capabilitySystemText)
  await textarea.fill('')
  await slashTrigger.click()
  await page.locator('[data-slash-option="skill:smoke-enabled"]').click()
  await writeFile(join(smokeEnabledSkillDir, 'SKILL.md'), smokeEnabledRaw.replace('Enabled test instructions.', 'Changed while selected instructions.'))
  await textarea.fill('Stale selected Skill must not send')
  const requestsBeforeStaleSkillSend = (await readFile(logPath, 'utf8')).split(/\r?\n/).filter(Boolean).length
  await textarea.press('Enter')
  await page.waitForFunction(() => document.body.innerText.includes('已选 Skill 已停用或内容发生变化') || document.body.innerText.includes('A selected Skill was disabled or changed'))
  const requestsAfterStaleSkillSend = (await readFile(logPath, 'utf8')).split(/\r?\n/).filter(Boolean).length
  check('selected Skill changes block send instead of silently dropping the Skill', requestsAfterStaleSkillSend === requestsBeforeStaleSkillSend && await page.locator('[data-input-attachments]').count() === 0)
  const changedEnabledRaw = smokeEnabledRaw.replace('Enabled test instructions.', 'Changed enabled test instructions.')
  await writeFile(join(smokeEnabledSkillDir, 'SKILL.md'), changedEnabledRaw)
  const changedSkills = await page.evaluate(() => window.joker.skill.list())
  const changedSkill = changedSkills.find((skill) => skill.id === 'smoke-enabled')
  check('Skill content changes automatically disable the previous fingerprint', changedSkill?.enabled === false && changedSkill?.trusted === false && changedSkill?.trustState === 'changed')
  await textarea.fill('')
  await slashTrigger.click()
  const changedSkillOption = page.locator('[data-slash-option="skill:smoke-enabled"]')
  check('changed Skills require re-enabling instead of separate trust', await changedSkillOption.getAttribute('aria-disabled') === 'true' && /内容已变化|changed/i.test(await changedSkillOption.innerText()) && !/未受信任|untrusted/i.test(await changedSkillOption.innerText()))
  await textarea.press('Escape')
  await page.getByRole('button', { name: /设置|Settings/i }).click()
  await page.getByRole('button', { name: /^Skills$/ }).click()
  check('changed Skill exposes one re-enable action', await page.locator('[data-testid="skill-toggle-smoke-enabled"]').innerText().then((text) => /重新启用|changed skill/i.test(text)) && await page.locator('[data-skill-card="smoke-enabled"] [data-testid^="skill-trust-"]').count() === 0)
  await page.locator('[data-testid="skill-toggle-smoke-enabled"]').click()
  await page.waitForFunction(() => window.joker.skill.list().then((skills) => skills.some((skill) => skill.id === 'smoke-enabled' && skill.enabled && skill.trusted && skill.trustState === 'trusted')))
  check('re-enabling trusts the changed content fingerprint', await page.evaluate(async () => {
    const [config, skills] = await Promise.all([window.joker.config.get(), window.joker.skill.list()])
    const skill = skills.find((candidate) => candidate.id === 'smoke-enabled')
    const record = (config.trustedSkills ?? []).find((candidate) => candidate.id === 'smoke-enabled')
    return Boolean(skill?.fingerprint && record?.fingerprint === skill.fingerprint)
  }))
  await page.getByRole('button', { name: /关闭设置|Close settings/i }).click()
  await textarea.fill('')
  await slashTrigger.click()
  await page.locator('[data-slash-option="skill:smoke-enabled"]').click()
  await textarea.fill('Changed Skill capability smoke')
  await textarea.press('Enter')
  await page.waitForFunction(() => document.body.innerText.includes('Fake Provider is online.'), undefined, { timeout: 30_000 })
  const changedCapabilityRequest = (await readFile(logPath, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).reverse().find((entry) => entry.body?.stream === true && entry.body.messages?.some((message) => String(message.content ?? '').includes('Changed Skill capability smoke')))
  const changedCapabilitySystemText = changedCapabilityRequest?.body?.messages?.filter((message) => message.role === 'system').map((message) => String(message.content ?? '')).join('\n') ?? ''
  check('re-enabled changed Skill uses the new instructions', changedCapabilitySystemText.includes('Changed enabled test instructions.') && !changedCapabilitySystemText.includes('\nEnabled test instructions.'), changedCapabilitySystemText)
  await textarea.fill('')
  await slashTrigger.click()
  await textarea.press('Tab')
  check('tab closes slash menu without inserting or sending', await slashMenu.count() === 0 && await textarea.inputValue() === '/')
  await textarea.fill('')
  await slashTrigger.click()
  const composer = page.locator('[data-input-composer]')
  const composerBox = await composer.boundingBox()
  const menuBox = await page.locator('[data-slash-menu]').boundingBox()
  check('slash menu stays above the input row without horizontal overflow', Boolean(composerBox && menuBox && menuBox.y + menuBox.height <= composerBox.y + 36 && menuBox.width <= composerBox.width), { composerBox, menuBox })
  await screenshot(page, 'slash-command-menu')
  await textarea.press('Escape')
  await textarea.fill('Cold-start stream regression')
  await textarea.press('Enter')
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
  await page.waitForSelector('textarea')
  const restoredConfig = await page.evaluate(() => window.joker.config.get())
  check('settings survive Electron restart', restoredConfig.providers?.[0]?.name === 'QA Provider Saved')
  const restoredSessions = await page.evaluate(() => window.joker.session.list())
  check('sessions survive Electron restart', restoredSessions.some((item) => item.id === session.id))
  const restoredCommandSession = await page.evaluate(async (sessionId) => sessionId ? window.joker.session.get(sessionId) : null, activeSessionId)
  check('structured completed unlimited Goal survives Electron restart', restoredCommandSession?.goal?.objective === 'Ship the corrected Slash command flow' && restoredCommandSession.goal.status === 'completed' && !Object.hasOwn(restoredCommandSession.goal, 'tokenLimit'))
  check('context checkpoint survives Electron restart', Boolean(restoredCommandSession?.contextCheckpoint?.sourceHash))
  const restoredSkills = await page.evaluate(() => window.joker.skill.list())
  const restoredEnabledSkill = restoredSkills.find((skill) => skill.id === 'smoke-enabled')
  check('Skill fingerprint-bound enablement survives Electron restart', restoredEnabledSkill?.enabled === true && restoredEnabledSkill?.trusted === true && restoredEnabledSkill?.trustState === 'trusted')
  const restoredCommandMeta = restoredSessions.find((item) => item.id === activeSessionId)
  check('compacted command session remains available after restart', Boolean(restoredCommandMeta))
  const restoredCommandButton = page.getByRole('button', { name: restoredCommandMeta?.title ?? '' }).first()
  await restoredCommandButton.click()
  await page.waitForFunction((expectedText) => document.body.innerText.includes(expectedText), String(restoredCommandSession?.messages[0]?.content ?? 'older request'))
  const restartedTextarea = page.locator('textarea').first()
  await restartedTextarea.fill('Checkpoint consumption smoke')
  await restartedTextarea.press('Enter')
  await page.waitForFunction(() => document.body.innerText.includes('Fake Provider is online.'), undefined, { timeout: 30_000 })
  const checkpointRequest = (await readFile(logPath, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).reverse().find((entry) => entry.body?.stream === true && entry.body.messages?.some((message) => String(message.content ?? '').includes('Checkpoint consumption smoke')))
  const checkpointSystemText = checkpointRequest?.body?.messages?.filter((message) => message.role === 'system').map((message) => String(message.content ?? '')).join('\n') ?? ''
  check('following chat consumes the persisted compact checkpoint', checkpointSystemText.includes('validated, model-generated historical context') && checkpointSystemText.includes('Slash+ exposes goal, plan, compact, and Skills.'), checkpointSystemText)
  await screenshot(page, 'restart')
  await page.waitForTimeout(100)
  check('slash+ regression has no renderer console errors', consoleErrors.length === 0, consoleErrors)
  check('slash+ regression has no renderer page errors', pageErrors.length === 0, pageErrors)
} finally {
  if (browser) await browser.close().catch(() => undefined)
  await stopProcess(electron)
  await stopProcess(provider)
  const report = {
    generatedAt: new Date().toISOString(),
    runDir,
    checks,
    screenshots,
    consoleErrors,
    pageErrors,
    providerOutput,
    electronOutput,
    providerExitCode: provider.exitCode,
    electronExitCode: electron?.exitCode ?? null
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  if (checks.some((item) => !item.pass)) process.exitCode = 1
  console.log(JSON.stringify({ reportPath, runDir, checks, screenshots }, null, 2))
}
