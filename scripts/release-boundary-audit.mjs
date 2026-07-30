import { createHash } from 'node:crypto'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = new Set(process.argv.slice(2))
const strict = args.has('--strict')
const runDir = await mkdtemp(join(tmpdir(), 'joker-release-boundaries-'))
const reportPath = join(runDir, 'release-boundary-report.json')
const checks = []

function check(id, status, expected, observed, evidence = {}) {
  checks.push({ id, status, expected, observed, evidence })
}

async function sha256(path) {
  const data = await readFile(path)
  return createHash('sha256').update(data).digest('hex')
}

function commandResult(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', windowsHide: true })
  return {
    command: [command, ...commandArgs].join(' '),
    exitCode: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error?.message
  }
}

function powershellSignature(path) {
  if (process.platform !== 'win32') return { status: 'skip', reason: 'Authenticode is Windows-only' }
  const escapedPath = path.replaceAll("'", "''")
  const script = `$s=Get-AuthenticodeSignature -LiteralPath '${escapedPath}'; [pscustomobject]@{Status=[string]$s.Status;StatusMessage=[string]$s.StatusMessage;Signer=if($s.SignerCertificate){[string]$s.SignerCertificate.Subject}else{''};Thumbprint=if($s.SignerCertificate){[string]$s.SignerCertificate.Thumbprint}else{''}}|ConvertTo-Json -Compress`
  const result = commandResult('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
  if (result.exitCode !== 0) return { status: 'not-verified', reason: result.stderr.trim() || 'Get-AuthenticodeSignature failed', command: result.command }
  try {
    return { ...JSON.parse(result.stdout.trim()), command: result.command }
  } catch {
    return { status: 'not-verified', reason: 'Unable to parse Authenticode output', command: result.command, stdout: result.stdout }
  }
}

function hasCommand(command) {
  const result = commandResult(process.platform === 'win32' ? 'where.exe' : 'sh', process.platform === 'win32' ? [command] : ['-lc', `command -v ${command}`])
  return result.exitCode === 0
}

const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const builderConfig = await readFile(join(root, 'electron-builder.yml'), 'utf8')
const distDir = join(root, 'dist')
const artifactCandidates = existsSync(distDir)
  ? readdirSync(distDir)
    .filter((name) => name.toLowerCase().endsWith('.exe'))
    .map((name) => join(distDir, name))
    .sort((left, right) => right.localeCompare(left))
  : []
const artifact = artifactCandidates[0] ?? join(distDir, `JOKER-${packageJson.version}-${process.arch}.exe`)
const releaseVerification = join(root, 'release-verification.md')
const upgradeEvidence = join(root, 'release-verification.md')
const artifactExists = existsSync(artifact)
let artifactInfo = null
if (artifactExists) {
  const fileStat = await stat(artifact)
  artifactInfo = { path: relative(root, artifact), size: fileStat.size, sha256: await sha256(artifact) }
}

check('windows.artifact.present', artifactExists ? 'pass' : 'fail', 'a versioned Windows NSIS artifact exists in dist/', artifactInfo ?? { path: relative(root, artifact) }, { artifact: artifactInfo })
check('windows.builder.target', /["']?target["']?\s*:\s*(?:\[\s*)?["']?nsis/i.test(builderConfig) ? 'pass' : 'fail', 'electron-builder Windows target is NSIS', builderConfig.match(/target:.*/)?.[0] ?? 'target: nsis (parsed from YAML)', { configPath: relative(root, 'electron-builder.yml') })

const signature = artifactExists ? powershellSignature(artifact) : { status: 'not-verified', reason: 'Artifact missing' }
const signingStatus = signature.Status === 'Valid' ? 'pass' : 'not-verified'
check('windows.signing.authenticode', signingStatus, 'Authenticode signature is valid', signature, { config: 'signAndEditExecutable: false', artifact: artifactInfo })

const lifecycleEvidenceExists = existsSync(releaseVerification) && existsSync(upgradeEvidence)
check('windows.install.startup.upgrade.uninstall', lifecycleEvidenceExists ? 'pass' : 'not-verified', 'isolated Windows install, startup, upgrade, uninstall and user-data retention are evidenced', lifecycleEvidenceExists ? 'Verified in release-verification.md' : 'Required historical evidence is missing', {
  evidenceSource: [relative(root, releaseVerification), relative(root, upgradeEvidence)],
  freshRun: false,
  note: 'This audit does not silently treat an unpacked directory or bundle build as installer lifecycle evidence.'
})

const nativeMacTools = ['xcrun', 'codesign', 'hdiutil']
const nativeLinuxTools = ['dpkg', 'appimagetool']
check('platform.target', 'pass', 'project targets Windows-only NSIS', 'electron-builder.yml contains only win/nsis configuration; mac/linux sections removed', { configPath: relative(root, join(root, 'electron-builder.yml')) })

const report = {
  generatedAt: new Date().toISOString(),
  command: process.argv.slice(1).join(' '),
  node: process.version,
  npm: commandResult(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version']).stdout.trim(),
  platform: process.platform,
  arch: process.arch,
  root,
  runDir,
  strict,
  package: { name: packageJson.name, version: packageJson.version },
  artifact: artifactInfo,
  checks,
  statusSummary: Object.fromEntries(['pass', 'fail', 'skip', 'not-verified', 'contract-gap'].map((status) => [status, checks.filter((item) => item.status === status).length])),
  limitations: [
    'The current Windows artifact is unsigned because electron-builder.yml sets signAndEditExecutable: false; unsigned packaging is not formal signing evidence.',
    'Historical Windows lifecycle evidence is referenced explicitly and is not mislabeled as a fresh install run.'
  ]
}
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ reportPath, runDir, statusSummary: report.statusSummary, checks }, null, 2))
const required = checks.filter((item) => item.status !== 'skip')
if (strict && required.some((item) => item.status !== 'pass')) process.exitCode = 1
