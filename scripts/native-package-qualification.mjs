import { chromium } from 'playwright-core'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const runDir = process.env.JOKER_NATIVE_REPORT_DIR ? resolve(process.env.JOKER_NATIVE_REPORT_DIR) : join(tmpdir(), `joker-native-package-${Date.now()}-${process.pid}`)
mkdirSync(runDir, { recursive: true })
const reportPath = join(runDir, 'native-package-report.json')
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const distDir = join(root, 'dist')
function findArtifact(extension) {
  if (!existsSync(distDir)) return null
  const candidates = readdirSync(distDir)
    .filter((name) => name.toLowerCase().endsWith(extension.toLowerCase()))
    .map((name) => join(distDir, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
  return candidates[0] ?? null
}
function findMacApp() {
  if (!existsSync(distDir)) return null
  const direct = [
    join(distDir, 'mac', 'JOKER.app'),
    join(distDir, 'mac-arm64', 'JOKER.app'),
    join(distDir, 'mac-x64', 'JOKER.app')
  ]
  for (const candidate of direct) if (existsSync(candidate)) return candidate
  for (const name of readdirSync(distDir)) {
    const candidate = join(distDir, name, 'JOKER.app')
    if (existsSync(candidate)) return candidate
  }
  return null
}
const artifactCandidates = {
  win32: findArtifact('.exe') ?? join(distDir, `JOKER-${packageJson.version}-${process.arch}.exe`),
  darwin: findArtifact('.dmg') ?? join(distDir, `JOKER-${packageJson.version}-${process.arch}.dmg`),
  linux: findArtifact('.AppImage') ?? join(distDir, `JOKER-${packageJson.version}-${process.arch}.AppImage`)
}
const artifact = artifactCandidates[process.platform]
const linuxDeb = findArtifact('.deb') ?? join(distDir, `JOKER-${packageJson.version}-${process.arch}.deb`)
const checks = []
const processEvents = []
function check(id, status, expected, observed, evidence = {}) { checks.push({ id, status, expected, observed, evidence }) }
function sha256(path) { return createHash('sha256').update(readFileSync(path)).digest('hex') }
function artifactInfo(path) { return { path, size: statSync(path).size, sha256: sha256(path) } }
async function waitForCdp(child, timeoutMs = 20_000) {
  let output = ''
  const endpoint = new Promise((resolveEndpoint, reject) => {
    const onData = (chunk) => {
      output += String(chunk)
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (match) resolveEndpoint(match[1])
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('error', reject)
    child.once('exit', (code, signal) => reject(new Error(`packaged app exited before CDP: ${code ?? 'null'}/${signal ?? 'null'}`)))
    setTimeout(() => reject(new Error(`packaged app did not expose CDP: ${output}`)), timeoutMs)
  })
  return { endpoint: await endpoint, output }
}
async function stop(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* best effort */ }
  } else {
    child.kill('SIGTERM')
    await Promise.race([once(child, 'exit'), new Promise((resolveStop) => setTimeout(resolveStop, 5000))])
    if (child.exitCode === null) child.kill('SIGKILL')
  }
}
async function qualifyPackagedExecutable(executable, label) {
  const home = join(runDir, `${label}-home`)
  const userData = join(runDir, `${label}-user-data`)
  const cdpPort = 19300 + Math.floor(Math.random() * 300)
  const launch = () => spawn(executable, [`--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userData}`], {
    cwd: root,
    env: { ...process.env, JOKER_HOME: home, ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let child = launch()
  processEvents.push({ label, phase: 'first-launch', pid: child.pid })
  try {
    const { endpoint } = await waitForCdp(child)
    const browser = await chromium.connectOverCDP(endpoint)
    const page = browser.contexts()[0]?.pages()[0]
    const text = page ? await page.locator('body').innerText() : ''
    check(`native.${process.platform}.${label}.startup`, page && (text.includes('JOKER') || text.includes('New conversation')) ? 'pass' : 'fail', 'packaged app starts and renders the application', { endpoint, hasPage: Boolean(page), titleTextObserved: text.slice(0, 240) }, { isolatedHome: home, isolatedUserData: userData })
    const appState = page ? await page.evaluate(async () => {
      const config = await window.joker.config.get()
      const session = await window.joker.session.create('native package qualification')
      const sessions = await window.joker.session.list()
      return { providerCount: config.providers.length, sessionId: session.id, sessionRestored: sessions.some((item) => item.id === session.id) }
    }) : null
    check(`native.${process.platform}.${label}.preload-persistence`, appState?.providerCount && appState.sessionRestored ? 'pass' : 'fail', 'packaged renderer/preload can read config and persist a session in isolated home', appState, { isolatedHome: home })
    await browser.close()
  } finally {
    await stop(child)
  }
  child = launch()
  processEvents.push({ label, phase: 'restart', pid: child.pid })
  try {
    const { endpoint } = await waitForCdp(child)
    const restarted = await chromium.connectOverCDP(endpoint)
    const page = restarted.contexts()[0]?.pages()[0]
    const sessions = page ? await page.evaluate(() => window.joker.session.list()) : []
    check(`native.${process.platform}.${label}.restart-persistence`, sessions.some((item) => item.title === 'native package qualification') ? 'pass' : 'fail', 'packaged app restores isolated session data after restart', { sessionCount: sessions.length }, { isolatedHome: home })
    await restarted.close()
  } finally {
    await stop(child)
  }
}

const strict = process.argv.includes('--strict')
const verifyNativeSigning = process.env.JOKER_NATIVE_VERIFY_SIGNING === '1'
let reportWritten = false
function writeReport() {
  if (reportWritten) return
  const report = {
    generatedAt: new Date().toISOString(),
    command: process.argv.slice(1).join(' '),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    runner: { ci: process.env.CI === 'true', githubRunner: process.env.RUNNER_OS ?? null },
    runDir,
    strict,
    artifact: artifact && existsSync(artifact) ? artifactInfo(artifact) : { path: artifact ?? null },
    processEvents,
    checks,
    statusSummary: Object.fromEntries(['pass', 'fail', 'skip', 'not-verified', 'contract-gap'].map((status) => [status, checks.filter((item) => item.status === status).length])),
    limitations: ['Native package installation/startup and formal signing are only passable after execution on the corresponding native runner with supplied credentials.', 'Windows local execution intentionally reports macOS/Linux as skip and formal signing as not-verified.']
  }
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  reportWritten = true
}
process.on('uncaughtException', (error) => {
  check('native.unexpected-error', 'fail', 'native qualification completes without an uncaught exception', error instanceof Error ? error.message : String(error), { reportPath })
  console.error(error instanceof Error ? error.message : String(error))
  writeReport()
  process.exitCode = 1
})
process.on('unhandledRejection', (error) => {
  check('native.unexpected-error', 'fail', 'native qualification completes without an unhandled rejection', error instanceof Error ? error.message : String(error), { reportPath })
  console.error(error instanceof Error ? error.message : String(error))
  writeReport()
  process.exitCode = 1
})

function installedDpkgExecutable(packageName) {
  const listed = spawnSync('dpkg', ['-L', packageName], { encoding: 'utf8' })
  if (listed.status !== 0 || listed.error) return { executable: null, listing: { status: listed.status, error: listed.error?.message ?? null } }
  const candidates = listed.stdout.split(/\r?\n/)
    .map((path) => path.trim())
    .filter((path) => path && existsSync(path))
    .filter((path) => /(?:^|[\\/])(joker|JOKER)$/.test(path))
    .filter((path) => { try { return statSync(path).isFile() } catch { return false } })
  return { executable: candidates[0] ?? null, listing: { status: listed.status, candidateCount: candidates.length } }
}

if (process.platform === 'win32') {
    check('native.macos', 'skip', 'native macOS runner', 'current host is Windows')
    check('native.linux', 'skip', 'native Linux runner', 'current host is Windows')
    check('signing.formal', 'not-verified', 'formal platform signing credentials', 'Windows artifact is unsigned in local environment')
  } else if (!existsSync(artifact)) {
  check(`native.${process.platform}.artifact`, 'fail', 'native package artifact exists', { path: artifact })
} else {
  const info = artifactInfo(artifact)
  check(`native.${process.platform}.artifact`, 'pass', 'native package artifact exists', info)
  if (process.platform === 'linux') {
    const appImageHelp = spawnSync(artifact, ['--appimage-help'], { encoding: 'utf8', timeout: 10_000 })
    check('native.linux.appimage-executable', appImageHelp.status === 0 && !appImageHelp.error ? 'pass' : 'not-verified', 'AppImage executable can be invoked on the native runner', { status: appImageHelp.status, error: appImageHelp.error?.message ?? null }, { artifact: info })
    const extracted = join(runDir, 'squashfs-root')
    const extract = spawnSync(artifact, ['--appimage-extract'], { cwd: runDir, encoding: 'utf8', timeout: 30_000 })
    const executable = existsSync(join(extracted, 'joker')) ? join(extracted, 'joker') : existsSync(join(extracted, 'JOKER')) ? join(extracted, 'JOKER') : null
    if (extract.status === 0 && !extract.error && executable) await qualifyPackagedExecutable(executable, 'appimage-extracted')
    else check('native.linux.appimage-startup', 'not-verified', 'extracted AppImage launches packaged application', { extractStatus: extract.status, error: extract.error?.message ?? null, executable })
    if (existsSync(linuxDeb)) {
      const dpkgQuery = spawnSync('dpkg-deb', ['-f', linuxDeb, 'Package', 'Version'], { encoding: 'utf8' })
      const metadata = Object.fromEntries((dpkgQuery.stdout ?? '').split(/\r?\n/).flatMap((line) => {
        const separator = line.indexOf(':')
        return separator > 0 ? [[line.slice(0, separator).trim(), line.slice(separator + 1).trim()]] : []
      }))
      const packageName = metadata.Package ?? ''
      check('native.linux.deb.inspect', dpkgQuery.status === 0 && !dpkgQuery.error ? 'pass' : 'not-verified', 'deb metadata is readable on the native runner', { status: dpkgQuery.status, output: dpkgQuery.stdout?.trim() ?? '', error: dpkgQuery.error?.message ?? null, metadata }, { artifact: artifactInfo(linuxDeb) })
      const preExisting = packageName ? spawnSync('dpkg-query', ['-W', '-f=${Status}', packageName], { encoding: 'utf8' }) : { status: 2, stdout: '', stderr: '', error: null }
      const packageWasInstalled = preExisting.status === 0 && /install ok installed/.test(preExisting.stdout ?? '')
      check('native.linux.deb.pre-existing', packageName && !packageWasInstalled ? 'pass' : 'fail', 'qualification does not remove a pre-existing installation', { packageName, packageWasInstalled, status: preExisting.status, error: preExisting.error?.message ?? null })
      const install = packageWasInstalled || !packageName
        ? { status: 1, stdout: '', stderr: packageWasInstalled ? 'package already installed before qualification' : 'deb metadata did not provide a package name', error: null }
        : spawnSync('sudo', ['-n', 'dpkg', '-i', linuxDeb], { encoding: 'utf8', timeout: 60_000 })
      let installedPackage = false
      try {
        if (install.status === 0 && packageName) {
          installedPackage = true
          check('native.linux.deb.install', 'pass', 'deb installs through dpkg on the native runner', { status: install.status, packageName })
          const resolved = installedDpkgExecutable(packageName)
          const installedExecutable = resolved.executable
          check('native.linux.deb.startup-target', installedExecutable ? 'pass' : 'not-verified', 'dpkg file list resolves the installed executable', { packageName, installedExecutable, listing: resolved.listing })
          if (installedExecutable) await qualifyPackagedExecutable(installedExecutable, 'deb-installed')
          else check('native.linux.deb.startup', 'not-verified', 'installed deb exposes the packaged executable', { packageName, listing: resolved.listing })
        } else {
          check('native.linux.deb.install', packageWasInstalled ? 'fail' : 'not-verified', 'deb installs through dpkg on the native runner', { status: install.status, error: install.error?.message ?? null, packageName })
        }
      } finally {
        if (installedPackage) {
          const uninstall = spawnSync('sudo', ['-n', 'dpkg', '-r', packageName], { encoding: 'utf8', timeout: 60_000 })
          check('native.linux.deb.uninstall', uninstall.status === 0 ? 'pass' : 'fail', 'deb is removed after qualification', { status: uninstall.status, packageName, error: uninstall.error?.message ?? null })
        }
      }
    } else {
      check('native.linux.deb.inspect', 'not-verified', 'matching deb artifact exists for install/startup qualification', { path: linuxDeb })
    }
  } else if (process.platform === 'darwin') {
    const mountPoint = join(runDir, 'dmg-mount')
    mkdirSync(mountPoint, { recursive: true })
    const attach = spawnSync('hdiutil', ['attach', artifact, '-nobrowse', '-readonly', '-mountpoint', mountPoint], { encoding: 'utf8' })
    const appSource = readdirSync(mountPoint).map((name) => join(mountPoint, name)).find((candidate) => candidate.toLowerCase().endsWith('.app')) ?? join(mountPoint, 'JOKER.app')
    const appCopy = join(runDir, 'JOKER.app')
    try {
      if (attach.status === 0 && existsSync(appSource)) {
        const copy = spawnSync('ditto', [appSource, appCopy], { encoding: 'utf8' })
        check('native.darwin.dmg-mount', copy.status === 0 && existsSync(appCopy) ? 'pass' : 'fail', 'DMG is mounted and app copied to an isolated path', { attachStatus: attach.status, copyStatus: copy.status, mountPoint, appCopy })
        if (verifyNativeSigning) {
          const signature = spawnSync('codesign', ['--verify', '--deep', '--strict', appCopy], { encoding: 'utf8' })
          check('native.darwin.codesign-verify', signature.status === 0 ? 'pass' : 'fail', 'copied app passes codesign verification', { status: signature.status, stderr: signature.stderr?.trim() ?? '' }, { appCopy })
          const gatekeeper = spawnSync('spctl', ['--assess', '--type', 'execute', '--verbose=2', appCopy], { encoding: 'utf8' })
          check('native.darwin.gatekeeper', gatekeeper.status === 0 ? 'pass' : 'fail', 'copied app passes Gatekeeper assessment', { status: gatekeeper.status, stderr: gatekeeper.stderr?.trim() ?? '', stdout: gatekeeper.stdout?.trim() ?? '' }, { appCopy })
          const notarization = spawnSync('stapler', ['validate', appCopy], { encoding: 'utf8' })
          check('native.darwin.notarization', notarization.status === 0 ? 'pass' : 'fail', 'copied app has a valid stapled notarization ticket', { status: notarization.status, stderr: notarization.stderr?.trim() ?? '' }, { appCopy })
        }

        if (copy.status === 0 && existsSync(appCopy)) await qualifyPackagedExecutable(join(appCopy, 'Contents', 'MacOS', 'JOKER'), 'dmg-copied')
      } else check('native.darwin.dmg-mount', 'fail', 'DMG is mounted and app copied to an isolated path', { attachStatus: attach.status, error: attach.error?.message ?? null, mountPoint })
    } finally {
      const detach = spawnSync('hdiutil', ['detach', mountPoint, '-force'], { encoding: 'utf8' })
      check('native.darwin.dmg-detach', detach.status === 0 ? 'pass' : 'fail', 'DMG mount is detached during cleanup', { status: detach.status, error: detach.error?.message ?? null, stderr: detach.stderr?.trim() ?? '' }, { mountPoint })
    }
  }
}

writeReport()
const requiredStatus = checks.some((item) => item.status === 'fail' || (strict && (item.status === 'skip' || item.status === 'not-verified')))
if (requiredStatus) process.exitCode = 1
