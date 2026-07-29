import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const unitTestFiles = [
  'src/main/providers/index.test.ts',
  'src/main/providers/image.test.ts',
  'src/main/tools/registry.test.ts',
  'src/main/tools/mcp-bridge.test.ts',
  'src/main/tools/subagent.test.ts',
  'src/main/tools/todo.test.ts',
  'src/main/tools/image.test.ts',
  'src/renderer/src/store.test.ts',
  'src/renderer/src/assistant-segments.test.ts',
  'src/renderer/src/message-minimap.test.ts',
  'src/shared/messages.test.ts',
  'src/main/store/config.test.ts',
  'src/main/store/image-config.test.ts',
  'src/main/store/projects.test.ts',
  'src/main/store/sessions.test.ts',
  'src/main/git/status.test.ts',
  'src/main/tools/git.test.ts',
  'src/main/store/generated-images.test.ts',
  'src/main/agent/context.test.ts',
  'src/main/agent/loop.test.ts',
  'src/main/stream-transport.test.ts',
  'src/main/agent/approval.test.ts',
  'src/main/agent/diagnostics.test.ts',
  'src/main/agent/capabilities.test.ts',
  'src/main/skills/loader.test.ts',
  'src/renderer/src/slash.test.ts',
  'src/main/tools/web.test.ts',
  'src/main/tools/web-search.test.ts',
  'src/renderer/src/url-preview.test.ts',
  'src/main/ipc/image-config.test.ts',
  'src/main/ipc/file.test.ts'
]

const integrationTestFiles = [
  'src/main/providers/integration.test.ts',
  'src/main/ipc/mcp-config.test.ts',
  'src/main/mcp/client.integration.test.ts',
  'src/main/tools/web.integration.test.ts',
  'src/main/tools/mcp-bridge.test.ts',
  'src/main/agent/approval.test.ts',
  'src/main/agent/capabilities.test.ts'
]

const coverage = process.argv.includes('--coverage')
const integration = process.argv.includes('--integration')
const testFiles = integration ? integrationTestFiles : unitTestFiles
const excludedOnWindows = new Set()
const platformTestFiles = process.platform === 'win32'
  ? testFiles.filter((file) => !excludedOnWindows.has(file))
  : testFiles
const selectedTestFiles = coverage ? platformTestFiles : platformTestFiles

if (integration && selectedTestFiles.length === 0) {
  console.error('No integration tests selected.')
  process.exitCode = 1
  process.exit()
}

const args = ['--test', '--import=tsx']
if (coverage) args.push('--experimental-test-coverage')
args.push(...selectedTestFiles)

const result = spawnSync(process.execPath, args, {
  stdio: coverage ? ['inherit', 'pipe', 'pipe'] : 'inherit',
  shell: false,
  encoding: 'utf8'
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
  const report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    mode: integration ? 'integration' : 'unit',
    testFiles: selectedTestFiles,
    excludedTestFiles: testFiles.filter((file) => !selectedTestFiles.includes(file)),
    note: 'Coverage is produced by Node test runner output. The companion text file preserves the measured report; this JSON is an auditable manifest of the exact test set and is not a fabricated percentage report.'
  }
  writeFileSync(join(reportDir, 'test-output.txt'), `${result.stdout ?? ''}${result.stderr ?? ''}`, 'utf8')
  writeFileSync(join(reportDir, 'test-manifest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`Coverage report written to ${join('coverage', 'test-output.txt')}`)
  console.log(`Coverage manifest written to ${join('coverage', 'test-manifest.json')}`)
}
