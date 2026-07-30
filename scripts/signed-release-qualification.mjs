import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
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
let reportWritten = false
function check(id, status, expected, observed, evidence = {}) { checks.push({ id, status, expected, observed, evidence }) }
function digest(path) { return createHash('sha256').update(readFileSync(path)).digest('hex') }
function info(path) { return { path, size: readFileSync(path).byteLength, sha256: digest(path) } }
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
process.on('exit', () => { writeReport() })
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
function safeEvidence(result) {
  return { status: result.status, error: result.error, stderr: result.stderr.trim().slice(-1000) }
}

const required = ['CSC_LINK', 'CSC_KEY_PASSWORD']
const missing = required.filter((name) => !has(name))
if (missing.length > 0) {
  check('signed.credentials.present', 'fail', 'all Windows Authenticode signing credentials are present', { missing }, { secretValuesLogged: false })
} else {
  const env = { ...process.env }
  env.CSC_LINK = process.env.CSC_LINK
  env.CSC_KEY_PASSWORD = process.env.CSC_KEY_PASSWORD
  const build = run('npm.cmd', ['run', 'build:dist', '--', '--win', 'nsis'], { cwd: root, env })
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
}

writeReport()
console.log(JSON.stringify({ reportPath, runDir, statusSummary: Object.fromEntries(['pass', 'fail', 'skip', 'not-verified', 'contract-gap'].map((status) => [status, checks.filter((item) => item.status === status).length])), secretValuesLogged: false }, null, 2))
if (checks.some((item) => item.status === 'fail' || item.status === 'not-verified')) process.exitCode = 1
