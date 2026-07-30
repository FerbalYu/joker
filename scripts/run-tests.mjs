import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const integration = process.argv.includes('--integration')
const coverage = process.argv.includes('--coverage')
const manifestOnly = process.argv.includes('--manifest-only')
const explicitIntegrationFiles = new Map([
  ['src/main/providers/integration.test.ts', 'provider HTTP contract uses a local fake server'],
  ['src/main/ipc/mcp-config.test.ts', 'MCP configuration contract is intentionally part of integration coverage'],
  ['src/main/mcp/client.integration.test.ts', 'MCP transport contract starts local servers'],
  ['src/main/tools/web.integration.test.ts', 'web contract may exercise browser and network adapters'],
  ['src/main/tools/mcp-bridge.test.ts', 'MCP bridge is shared with the integration contract'],
  ['src/main/agent/approval.test.ts', 'approval behavior is shared with Electron integration flows'],
  ['src/main/agent/capabilities.test.ts', 'capability assembly is shared with integration flows']
])
const unitExclusions = new Map([
  ['src/main/providers/integration.test.ts', 'integration-only local provider contract'],
  ['src/main/mcp/client.integration.test.ts', 'integration-only MCP transport contract'],
  ['src/main/tools/web.integration.test.ts', 'integration-only web contract']
])

const allTestFiles = discoverTests(join(process.cwd(), 'src'))
const integrationFiles = uniqueSorted([
  ...allTestFiles.filter((file) => file.endsWith('.integration.test.ts')),
  ...explicitIntegrationFiles.keys()
])
const unitFiles = allTestFiles.filter((file) => !unitExclusions.has(file) && !file.endsWith('.integration.test.ts'))
const selectedTestFiles = integration ? integrationFiles : unitFiles

for (const [file, reason] of [...explicitIntegrationFiles, ...unitExclusions]) {
  if (!reason.trim()) fail(`Test classification requires a reason: ${file}`)
  if (!allTestFiles.includes(file)) fail(`Classified test file does not exist: ${file}`)
}
if (selectedTestFiles.length === 0) fail(`No ${integration ? 'integration' : 'unit'} tests selected.`)

const manifest = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  mode: integration ? 'integration' : 'unit',
  testFiles: selectedTestFiles,
  allDiscoveredTests: allTestFiles,
  unitExclusions: Object.fromEntries(unitExclusions),
  explicitIntegrationFiles: Object.fromEntries(explicitIntegrationFiles)
}

console.log(`Discovered ${allTestFiles.length} test files; running ${selectedTestFiles.length} ${manifest.mode} files.`)
selectedTestFiles.forEach((file) => console.log(`  ${file}`))
if (manifestOnly) process.exit()

const isolatedHome = mkdtempSync(join(tmpdir(), 'joker-tests-'))
const env = { ...process.env, JOKER_HOME: isolatedHome }
for (const key of Object.keys(env)) {
  if (isCredentialVariable(key)) delete env[key]
}

const args = ['--test', '--import=tsx']
if (coverage) args.push('--experimental-test-coverage')
args.push(...selectedTestFiles)

try {
  const result = spawnSync(process.execPath, args, {
    stdio: coverage ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    shell: false,
    encoding: 'utf8',
    env
  })
  if (coverage) {
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
  }
  if (result.error) {
    console.error(result.error.message)
    process.exitCode = 1
  } else {
    process.exitCode = result.status ?? 1
  }

  if (coverage && process.exitCode === 0) {
    const reportDir = join(process.cwd(), 'coverage')
    mkdirSync(reportDir, { recursive: true })
    writeFileSync(join(reportDir, 'test-output.txt'), `${result.stdout ?? ''}${result.stderr ?? ''}`, 'utf8')
    writeFileSync(join(reportDir, 'test-manifest.json'), `${JSON.stringify({
      ...manifest,
      note: 'Coverage is produced by Node test runner output. The companion text file preserves the measured report; this JSON is an auditable manifest of the exact test set and is not a fabricated percentage report.'
    }, null, 2)}\n`, 'utf8')
    console.log(`Coverage report written to ${join('coverage', 'test-output.txt')}`)
    console.log(`Coverage manifest written to ${join('coverage', 'test-manifest.json')}`)
  }
} finally {
  rmSync(isolatedHome, { recursive: true, force: true })
}

function discoverTests(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return discoverTests(path)
    if (!entry.isFile() || !entry.name.endsWith('.test.ts')) return []
    return [relative(process.cwd(), path).replaceAll('\\', '/')]
  }).sort()
}

function uniqueSorted(files) {
  return [...new Set(files)].sort()
}

function isCredentialVariable(key) {
  const normalized = key.toUpperCase()
  return normalized.endsWith('_API_KEY') || normalized.endsWith('_TOKEN') || [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'AZURE_OPENAI_API_KEY',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN'
  ].includes(normalized)
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
