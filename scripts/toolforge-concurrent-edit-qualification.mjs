import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const retainDirArg = process.argv.find((argument) => argument.startsWith('--retain-dir='))
const retainDir = resolve(root, retainDirArg ? retainDirArg.slice('--retain-dir='.length) : '.qa/toolforge-concurrent-edit')
const reportPath = resolve(retainDir, 'report.json')
const outputPath = resolve(retainDir, 'test-output.txt')
const testName = 'concurrent edit jobs from one stable base fail closed when the stale job promotes second'

await rm(retainDir, { recursive: true, force: true })
await mkdir(retainDir, { recursive: true })

let output = ''
let exitCode = 1
let failure
try {
  const child = spawn(process.execPath, [
    '--test',
    '--test-concurrency=1',
    '--test-name-pattern',
    testName,
    '--import=tsx',
    'src/main/generated-tools/edit-lifecycle.test.ts'
  ], {
    cwd: root,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  child.stdout.on('data', (chunk) => { output += String(chunk) })
  child.stderr.on('data', (chunk) => { output += String(chunk) })
  exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolveExit(code ?? 1))
  })
} catch (error) {
  failure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) }
}

await writeFile(outputPath, output, 'utf8')
const passed = !failure && exitCode === 0 && output.includes(testName)
const report = {
  schemaVersion: 1,
  qualification: 'toolforge-concurrent-edit',
  generatedAt: new Date().toISOString(),
  command: `node --test --test-concurrency=1 --test-name-pattern "${testName}" --import=tsx src/main/generated-tools/edit-lifecycle.test.ts`,
  checks: [{
    id: 'concurrent-modification',
    name: 'concurrent-modification stale second edit is denied while the first promoted version remains stable',
    pass: passed
  }],
  testOutput: 'test-output.txt',
  exitCode,
  ...(failure ? { failure } : {}),
  passed
}
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ reportPath, outputPath, passed, exitCode, failure }, null, 2))
if (!passed) process.exitCode = 1
