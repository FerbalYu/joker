import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

function fail(message) {
  console.error(`release provenance failed: ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const command = argv.shift()
  if (command !== 'create' && command !== 'verify') fail('expected create or verify')
  const options = { command, artifacts: [], reports: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[++index]
    if (!value) fail(`${flag} requires a value`)
    if (flag === '--output' || flag === '--manifest') options[flag.slice(2)] = resolve(value)
    else if (flag === '--artifact') options.artifacts.push(resolve(value))
    else if (flag === '--report') options.reports.push(resolve(value))
    else fail(`unknown flag: ${flag}`)
  }
  if (command === 'create' && !options.output) fail('create requires --output')
  if (command === 'verify' && !options.manifest) fail('verify requires --manifest')
  return options
}

function run(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', windowsHide: true }).trim()
  } catch (error) {
    fail(`${command} ${args.join(' ')} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function fileIdentity(path, root) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`not a regular non-symlink file: ${path}`)
  const normalizedRoot = resolve(root)
  const normalizedPath = resolve(path)
  const rel = relative(normalizedRoot, normalizedPath)
  return {
    path: rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.replaceAll('\\', '/') : normalizedPath,
    size: stat.size,
    sha256: sha256(normalizedPath)
  }
}

function signature(path) {
  if (process.platform !== 'win32' || !path.toLowerCase().endsWith('.exe')) return undefined
  const escaped = resolve(path).replaceAll("'", "''")
  const output = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$s=Get-AuthenticodeSignature -LiteralPath '${escaped}'; [pscustomobject]@{status=[string]$s.Status;subject=if($s.SignerCertificate){[string]$s.SignerCertificate.Subject}else{''};thumbprint=if($s.SignerCertificate){[string]$s.SignerCertificate.Thumbprint}else{''}}|ConvertTo-Json -Compress`])
  try { return JSON.parse(output) } catch { fail(`unable to parse Authenticode result for ${path}`) }
}

function resolveRecordedPath(root, recorded) {
  return isAbsolute(recorded) ? recorded : resolve(root, recorded)
}

const options = parseArgs(process.argv.slice(2))
if (options.command === 'verify') {
  const manifest = JSON.parse(readFileSync(options.manifest, 'utf8'))
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) fail('invalid provenance manifest')
  for (const item of manifest.files) {
    const path = resolveRecordedPath(manifest.root, item.path)
    const actual = fileIdentity(path, manifest.root)
    if (actual.size !== item.size || actual.sha256 !== item.sha256) fail(`artifact identity changed: ${item.path}`)
    if (item.signature) {
      const actualSignature = signature(path)
      if (actualSignature?.status !== item.signature.status || actualSignature?.thumbprint !== item.signature.thumbprint) fail(`artifact signature changed: ${item.path}`)
    }
  }
  console.log(JSON.stringify({ verified: true, manifest: options.manifest, files: manifest.files.length }))
  process.exit(0)
}

const root = resolve(process.cwd())
const required = [
  resolve(root, 'package.json'),
  resolve(root, 'package-lock.json'),
  resolve(root, 'electron-builder.yml'),
  resolve(root, 'out/main/index.js'),
  resolve(root, 'out/main/generated-tool-worker.js'),
  resolve(root, 'out/preload/index.mjs'),
  ...options.artifacts,
  ...options.reports
]
const unique = [...new Set(required)]
const files = unique.map((path) => {
  const identity = fileIdentity(path, root)
  const signed = signature(path)
  return signed ? { ...identity, signature: signed } : identity
})
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  root,
  repository: {
    commit: run('git', ['rev-parse', 'HEAD']),
    ref: process.env.GITHUB_REF ?? run('git', ['rev-parse', '--abbrev-ref', 'HEAD']),
    tag: process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : null,
    dirty: run('git', ['status', '--porcelain']).length > 0
  },
  workflow: {
    repository: process.env.GITHUB_REPOSITORY ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    sha: process.env.GITHUB_SHA ?? null
  },
  runtime: {
    node: process.version,
    npm: run(process.execPath, [resolve(process.execPath, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'), '--version']),
    package: { name: packageJson.name, version: packageJson.version },
    electron: packageJson.devDependencies?.electron ?? null,
    electronBuilder: packageJson.devDependencies?.['electron-builder'] ?? null
  },
  files
}
writeFileSync(options.output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ created: true, manifest: options.output, files: files.length }))
