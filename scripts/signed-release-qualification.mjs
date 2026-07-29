import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const runDir = resolve(process.env.JOKER_SIGNED_REPORT_DIR ?? join(tmpdir(), `joker-signed-release-${Date.now()}-${process.pid}`))
mkdirSync(runDir, { recursive: true })
const reportPath = join(runDir, 'signed-release-report.json')
const checks = []
const secretsUsed = new Set()
const temporarySecretPaths = new Set()
const temporaryGpgHome = process.platform === 'linux' ? mkdtempSync(join(tmpdir(), 'joker-signed-gpg-')) : null
if (temporaryGpgHome) {
  chmodSync(temporaryGpgHome, 0o700)
  temporarySecretPaths.add(temporaryGpgHome)
}
let reportWritten = false
function check(id, status, expected, observed, evidence = {}) { checks.push({ id, status, expected, observed, evidence }) }
function digest(path) { return createHash('sha256').update(readFileSync(path)).digest('hex') }
function info(path) { return { path, size: readFileSync(path).byteLength, sha256: digest(path) } }
function cleanupTemporarySecrets() {
  for (const path of temporarySecretPaths) {
    try { rmSync(path, { force: true, recursive: true }) } catch { /* best effort */ }
  }
  temporarySecretPaths.clear()
}
function writeReport() {
  if (reportWritten) return
  const report = {
    generatedAt: new Date().toISOString(),
    command: process.argv.slice(1).join(' '),
    platform: process.platform,
    arch: process.arch,
    package: { name: packageJson.name, version: packageJson.version },
    runDir,
    checks,
    statusSummary: Object.fromEntries(['pass', 'fail', 'skip', 'not-verified', 'contract-gap'].map((status) => [status, checks.filter((item) => item.status === status).length])),
    secretNamesUsed: [...secretsUsed],
    secretValuesLogged: false,
    limitations: ['This script never records secret values. A signed release is accepted only when every required sign and independent verify check is pass; absent credentials fail closed.']
  }
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  reportWritten = true
}
process.on('exit', () => {
  cleanupTemporarySecrets()
  writeReport()
})
process.on('uncaughtException', (error) => {
  check('signed.unexpected-error', 'fail', 'signed qualification completes without an uncaught exception', error instanceof Error ? error.message : String(error), { secretValuesLogged: false })
  console.error(error)
  process.exitCode = 1
})
process.on('unhandledRejection', (error) => {
  check('signed.unexpected-error', 'fail', 'signed qualification completes without an unhandled rejection', error instanceof Error ? error.message : String(error), { secretValuesLogged: false })
  console.error(error)
  process.exitCode = 1
})
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { ...options, encoding: 'utf8', windowsHide: true })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error?.message ?? null }
}
function has(name) {
  const value = process.env[name]
  if (!value) return false
  secretsUsed.add(name)
  return true
}
function artifact(extension) {
  const dist = join(root, 'dist')
  if (!existsSync(dist)) return null
  const exact = join(dist, `JOKER-${packageJson.version}-${process.arch}${extension}`)
  if (existsSync(exact) && statSync(exact).isFile()) return exact
  const candidates = readdirSync(dist)
    .filter((name) => name.toLowerCase().endsWith(extension.toLowerCase()))
    .map((name) => join(dist, name))
    .filter((path) => statSync(path).isFile())
  return candidates.length === 1 ? candidates[0] : null
}
function macApp() {
  const dist = join(root, 'dist')
  const candidates = ['mac', 'mac-arm64', 'mac-x64'].map((dir) => join(dist, dir, 'JOKER.app'))
  return candidates.find((path) => existsSync(path)) ?? null
}
function safeEvidence(result) {
  return { status: result.status, error: result.error, stderr: result.stderr.trim().slice(-1000) }
}
function requiredSecretNames() {
  if (process.platform === 'linux') return ['GPG_PRIVATE_KEY', 'GPG_KEY_ID']
  if (process.platform === 'darwin') return ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']
  if (process.platform === 'win32') return ['CSC_LINK', 'CSC_KEY_PASSWORD']
  return []
}
function materializeAppleApiKey() {
  const value = process.env.APPLE_API_KEY
  if (!value) return null
  if (existsSync(value)) return value
  const path = join(tmpdir(), `joker-apple-api-${process.pid}.p8`)
  writeFileSync(path, value, { encoding: 'utf8', mode: 0o600 })
  temporarySecretPaths.add(path)
  return path
}
function signingEnvironment() {
  const env = { ...process.env }
  for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'GPG_PRIVATE_KEY', 'GPG_KEY_ID']) delete env[name]
  if (process.platform === 'linux' && temporaryGpgHome) env.GNUPGHOME = temporaryGpgHome
  if (process.platform === 'win32' || process.platform === 'darwin') {
    if (process.env.CSC_LINK) env.CSC_LINK = process.env.CSC_LINK
    if (process.env.CSC_KEY_PASSWORD) env.CSC_KEY_PASSWORD = process.env.CSC_KEY_PASSWORD
  }
  if (process.platform === 'linux' && process.env.GPG_KEY_ID) env.GPG_KEY_ID = process.env.GPG_KEY_ID
  return env
}
function buildEnvironment() {
  return signingEnvironment()
}

const required = requiredSecretNames()
if (process.platform === 'linux' && process.env.GPG_PRIVATE_KEY && process.env.GPG_KEY_ID && temporaryGpgHome) {
  const imported = run('gpg', ['--batch', '--import'], { env: { ...signingEnvironment(), GNUPGHOME: temporaryGpgHome }, input: process.env.GPG_PRIVATE_KEY })
  if (imported.status !== 0) check('signed.linux.credentials.import', 'fail', 'GPG private key imports into an isolated keyring', safeEvidence(imported), { secretValuesLogged: false })
}
const missing = required.filter((name) => !has(name))
if (missing.length > 0) {
  check('signed.credentials.present', 'fail', 'all platform signing credentials are present', { missing }, { secretValuesLogged: false })
} else if (process.platform === 'win32') {
  const build = run('npm.cmd', ['run', 'build:dist', '--', '--win', 'nsis'], { cwd: root, env: buildEnvironment() })
  check('signed.windows.build', build.status === 0 ? 'pass' : 'fail', 'signed Windows NSIS package builds', safeEvidence(build))
  const exe = build.status === 0 ? artifact('.exe') : null
  check('signed.windows.artifact', exe ? 'pass' : 'fail', 'signed Windows artifact exists', exe ? info(exe) : { dist: join(root, 'dist') })
  if (exe) {
    const escaped = exe.replaceAll("'", "''")
    const verify = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$s=Get-AuthenticodeSignature -LiteralPath '${escaped}'; [pscustomobject]@{Status=[string]$s.Status;Signer=if($s.SignerCertificate){[string]$s.SignerCertificate.Subject}else{''};Thumbprint=if($s.SignerCertificate){[string]$s.SignerCertificate.Thumbprint}else{''}}|ConvertTo-Json -Compress`])
    let parsed = null
    try { parsed = JSON.parse(verify.stdout.trim()) } catch { /* reported below */ }
    check('signed.windows.authenticode', parsed?.Status === 'Valid' && Boolean(parsed.Signer) && Boolean(parsed.Thumbprint) ? 'pass' : 'fail', 'Authenticode status is Valid with signer and thumbprint', parsed ?? safeEvidence(verify), { artifact: info(exe) })
  }
} else if (process.platform === 'darwin') {
  const build = run('npm', ['run', 'build:dist', '--', '--mac', 'dmg'], { cwd: root, env: buildEnvironment() })
  check('signed.macos.build', build.status === 0 ? 'pass' : 'fail', 'signed macOS DMG builds', safeEvidence(build))
  const dmg = build.status === 0 ? artifact('.dmg') : null
  check('signed.macos.artifact', dmg ? 'pass' : 'fail', 'signed macOS DMG exists', dmg ? info(dmg) : { dist: join(root, 'dist') })
  const app = macApp()
  if (existsSync(app ?? '')) {
    const verify = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
    check('signed.macos.codesign', verify.status === 0 ? 'pass' : 'fail', 'codesign verification succeeds', safeEvidence(verify), { app })
    const gatekeeper = run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app])
    check('signed.macos.gatekeeper', gatekeeper.status === 0 ? 'pass' : 'fail', 'Gatekeeper assessment succeeds', safeEvidence(gatekeeper), { app })
    if (dmg && has('APPLE_API_KEY') && has('APPLE_API_KEY_ID') && has('APPLE_API_ISSUER')) {
      const apiKeyPath = materializeAppleApiKey()
      const notarize = apiKeyPath
        ? run('xcrun', ['notarytool', 'submit', dmg, '--key', apiKeyPath, '--key-id', process.env.APPLE_API_KEY_ID, '--issuer', process.env.APPLE_API_ISSUER, '--wait', '--output-format', 'json'])
        : { status: null, stdout: '', stderr: '', error: 'APPLE_API_KEY could not be materialized' }
      let notarizationResult = null
      try { notarizationResult = JSON.parse(notarize.stdout.trim()) } catch { /* reported below */ }
      check('signed.macos.notarization.submit', notarizationResult?.status === 'Accepted' ? 'pass' : 'fail', 'notarytool accepts the DMG submission', notarizationResult ?? safeEvidence(notarize), { artifact: info(dmg) })
      if (notarizationResult?.status === 'Accepted') {
        const staple = run('xcrun', ['stapler', 'staple', dmg])
        check('signed.macos.notarization.staple', staple.status === 0 ? 'pass' : 'fail', 'notarization ticket is stapled to the DMG', safeEvidence(staple), { artifact: info(dmg) })
        const validate = run('xcrun', ['stapler', 'validate', dmg])
        check('signed.macos.notarization.validate', validate.status === 0 ? 'pass' : 'fail', 'stapled notarization ticket validates', safeEvidence(validate), { artifact: info(dmg) })
      }
      if (apiKeyPath.startsWith(join(runDir, 'apple-api-key.'))) rmSync(apiKeyPath, { force: true })
    } else if (!dmg) {
      check('signed.macos.notarization.artifact', 'fail', 'DMG artifact exists before notarization', { dist: join(root, 'dist') })
    }
  } else {
    check('signed.macos.app', 'fail', 'signed macOS app bundle exists for verification', { app: macApp() })
  }
} else if (process.platform === 'linux') {
  const build = run('npm', ['run', 'build:dist', '--', '--linux', 'AppImage', 'deb'], { cwd: root, env: buildEnvironment() })
  check('signed.linux.build', build.status === 0 ? 'pass' : 'fail', 'Linux packages build before signing', safeEvidence(build))
  const files = build.status === 0 ? [artifact('.AppImage'), artifact('.deb')].filter(Boolean) : []
  check('signed.linux.artifacts', files.length === 2 ? 'pass' : 'fail', 'AppImage and deb artifacts exist', files.map((path) => info(path)))
  for (const path of files) {
    const signaturePath = `${path}.asc`
    const sign = run('gpg', ['--batch', '--yes', '--local-user', process.env.GPG_KEY_ID, '--armor', '--detach-sign', '--output', signaturePath, path])
    check(`signed.linux.sign.${path.split(/[\\/]/).at(-1)}`, sign.status === 0 ? 'pass' : 'fail', 'artifact receives a detached GPG signature', safeEvidence(sign), { artifact: info(path), signaturePath })
    if (sign.status === 0) {
      const verify = run('gpg', ['--batch', '--status-fd', '1', '--verify', signaturePath, path])
      check(`signed.linux.verify.${path.split(/[\\/]/).at(-1)}`, verify.status === 0 && verify.stdout.includes('[GNUPG:] GOODSIG'), 'detached GPG signature verifies', { status: verify.status, goodSig: verify.stdout.includes('[GNUPG:] GOODSIG'), error: verify.error }, { artifact: info(path), signaturePath })
    }
  }
} else {
  check('signed.platform.supported', 'fail', 'supported signing platform', process.platform)
}

const report = {
  generatedAt: new Date().toISOString(),
  command: process.argv.slice(1).join(' '),
  platform: process.platform,
  arch: process.arch,
  package: { name: packageJson.name, version: packageJson.version },
  runDir,
  checks,
  statusSummary: Object.fromEntries(['pass', 'fail', 'skip', 'not-verified', 'contract-gap'].map((status) => [status, checks.filter((item) => item.status === status).length])),
  secretNamesUsed: [...secretsUsed],
  secretValuesLogged: false,
  limitations: ['This script never records secret values. A signed release is accepted only when every required sign and independent verify check is pass; absent credentials fail closed.']
}
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ reportPath, runDir, statusSummary: report.statusSummary, secretValuesLogged: false }, null, 2))
if (report.statusSummary.fail > 0 || report.statusSummary['not-verified'] > 0) process.exitCode = 1
