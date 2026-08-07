import { chromium } from 'playwright-core'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const runDir = await mkdtemp(join(tmpdir(), 'joker-file-context-menu-'))
const home = join(runDir, 'home')
const userData = join(runDir, 'electron-user-data')
const targetPath = join(root, 'src', 'main', 'ipc', 'file-context-menu.ts')
const targetUrl = `${pathToFileURL(targetPath)}?line=1`
const missingUrl = pathToFileURL(join(root, 'missing-file-context-menu.txt')).toString()
const artifactDir = join(root, 'output', 'playwright')
const screenshotPath = join(artifactDir, 'file-context-menu.png')
const inlineScreenshotPath = join(artifactDir, 'file-link-inline.png')
const reportPath = join(artifactDir, 'file-context-menu-report.json')
const cdpPort = 19800 + Math.floor(Math.random() * 300)
const electronOutput = []
const checks = []
let electron
let browser

function check(name, pass, details = undefined) {
  checks.push({ name, pass: Boolean(pass), ...(details === undefined ? {} : { details }) })
  if (!pass) throw new Error(`Electron file context menu smoke failed: ${name}`)
}

function powershell(command, extraEnv = {}) {
  return execFileSync('powershell.exe', ['-NoProfile', '-Sta', '-Command', command], {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    windowsHide: true
  })
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* best effort */ }
  } else {
    child.kill('SIGTERM')
  }
}

try {
  await mkdir(home, { recursive: true })
  await mkdir(artifactDir, { recursive: true })
  electron = spawn(resolve(root, 'node_modules', 'electron', 'dist', 'electron.exe'), [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userData}`,
    resolve(root, 'out', 'main', 'index.js')
  ], {
    cwd: root,
    env: { ...process.env, HOME: home, USERPROFILE: home, JOKER_HOME: home, ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false
  })
  const onData = (chunk) => electronOutput.push(String(chunk))
  electron.stdout.on('data', onData)
  electron.stderr.on('data', onData)

  const ws = await new Promise((resolveEndpoint, reject) => {
    const inspect = () => {
      const match = electronOutput.join('').match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (match) resolveEndpoint(match[1])
    }
    electron.stdout.on('data', inspect)
    electron.stderr.on('data', inspect)
    electron.once('error', reject)
    electron.once('exit', (code, signal) => reject(new Error(`Electron exited before CDP: code=${code} signal=${signal}`)))
    setTimeout(() => reject(new Error(`Electron did not expose CDP: ${electronOutput.join('')}`)), 20_000)
  })

  browser = await chromium.connectOverCDP(ws)
  const page = browser.contexts()[0].pages()[0]
  await page.waitForLoadState('domcontentloaded')
  await page.waitForSelector('textarea')

  const sessionId = await page.evaluate(async ({ targetUrl, missingUrl }) => {
    const session = await window.joker.session.create('文件右键菜单验收')
    const saved = await window.joker.session.replaceMessages(session.id, [{
      id: 'file-context-menu-smoke',
      role: 'assistant',
      content: `右键验收：[file-context-menu.ts](${targetUrl})\n\n异常验收：[missing-file.txt](${missingUrl})`,
      createdAt: Date.now()
    }])
    if (!saved) throw new Error('Unable to seed file-link message')
    return session.id
  }, { targetUrl, missingUrl })
  await page.reload()
  await page.waitForSelector('textarea')
  const sessionButton = page.locator(`[data-session-id="${sessionId}"] > button`).first()
  await sessionButton.waitFor({ state: 'visible' })
  await sessionButton.click()
  await page.waitForTimeout(1_000)
  const fileLinks = page.locator('[data-testid="file-link"]')
  await fileLinks.first().waitFor({ state: 'visible' })
  check('local file links render in the restored Electron session', await fileLinks.count() === 2 && await fileLinks.first().getAttribute('title') === targetUrl, { sessionId, targetUrl })
  const inlineStyle = await fileLinks.first().evaluate((element) => {
    const buttonStyle = window.getComputedStyle(element)
    const name = element.querySelector('[data-file-link-name]')
    const nameStyle = name ? window.getComputedStyle(name) : null
    return {
      text: element.textContent ?? '',
      backgroundColor: buttonStyle.backgroundColor,
      borderTopWidth: buttonStyle.borderTopWidth,
      borderRightWidth: buttonStyle.borderRightWidth,
      borderBottomWidth: buttonStyle.borderBottomWidth,
      borderLeftWidth: buttonStyle.borderLeftWidth,
      nameBorderStyle: nameStyle?.borderBottomStyle ?? '',
      nameBorderWidth: nameStyle?.borderBottomWidth ?? ''
    }
  })
  check(
    'file links use icon-and-name hyperlink styling without card chrome',
    inlineStyle.backgroundColor === 'rgba(0, 0, 0, 0)'
      && [inlineStyle.borderTopWidth, inlineStyle.borderRightWidth, inlineStyle.borderBottomWidth, inlineStyle.borderLeftWidth].every((width) => width === '0px')
      && inlineStyle.nameBorderStyle === 'dotted'
      && inlineStyle.nameBorderWidth !== '0px'
      && !/资源管理器|Explorer|JOKER Markdown/.test(inlineStyle.text),
    inlineStyle
  )
  await page.screenshot({ path: inlineScreenshotPath })

  await fileLinks.nth(1).click({ button: 'right' })
  await page.getByText('文件不存在', { exact: true }).waitFor({ state: 'visible' })
  check('missing files return visible recovery feedback without opening a menu', true)

  await page.bringToFront()
  await fileLinks.first().click({ button: 'right' })
  await page.waitForTimeout(500)
  const capture = [
    'Add-Type -AssemblyName System.Drawing',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    '$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height',
    '$graphics = [System.Drawing.Graphics]::FromImage($bitmap)',
    '$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)',
    '$bitmap.Save($env:JOKER_CAPTURE_PATH, [System.Drawing.Imaging.ImageFormat]::Png)',
    '$graphics.Dispose()',
    '$bitmap.Dispose()'
  ].join('; ')
  powershell(capture, { JOKER_CAPTURE_PATH: screenshotPath })
  check('native context menu screenshot was captured', true, screenshotPath)
} finally {
  if (browser) await browser.close().catch(() => undefined)
  await stopProcess(electron)
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), runDir, checks, screenshotPath, inlineScreenshotPath, electronOutput }, null, 2)}\n`)
  console.log(JSON.stringify({ reportPath, screenshotPath, inlineScreenshotPath, checks }, null, 2))
}
