import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = new Map()
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index]
  if (!value.startsWith('--')) continue
  const [key, inline] = value.slice(2).split('=', 2)
  args.set(key, inline ?? process.argv[++index])
}
const workers = Math.max(2, Number(args.get('workers') ?? 6))
const workerPath = join(root, 'scripts', 'fixtures', 'toolforge-persistence-worker.mjs')
const jokerHome = process.env.JOKER_HOME?.trim()
if (!jokerHome) throw new Error('JOKER_HOME is required for ToolForge persistence qualification')

const children = []
for (let index = 0; index < workers; index += 1) {
  const child = spawn(process.execPath, ['--import=tsx', workerPath, jokerHome, String(index)], {
    cwd: root,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, JOKER_HOME: jokerHome }
  })
  const output = { workerId: index, stdout: '', stderr: '' }
  child.stdout.on('data', (chunk) => { output.stdout += String(chunk) })
  child.stderr.on('data', (chunk) => { output.stderr += String(chunk) })
  children.push({ child, output })
}
await Promise.all(children.map(({ child, output }) => new Promise((resolveReady, reject) => {
  if (output.stdout.includes('READY')) return resolveReady()
  const timer = setTimeout(() => reject(new Error(`worker readiness timeout: pid=${child.pid}; stderr=${output.stderr}`)), 10_000)
  const onData = () => {
    if (!output.stdout.includes('READY')) return
    clearTimeout(timer)
    child.stdout.off('data', onData)
    resolveReady()
  }
  child.stdout.on('data', onData)
})))
for (const { child } of children) child.stdin.write('GO\n')
const exits = await Promise.all(children.map(({ child, output }) => new Promise((resolveExit) => {
  child.once('exit', (code, signal) => resolveExit({ code, signal, ...output }))
})))

const storePath = join(jokerHome, '.joker', 'generated-tools', 'invocations.json')
const store = existsSync(storePath) ? JSON.parse(await readFile(storePath, 'utf8')) : null
const successful = exits.filter((exit) => exit.code === 0)
const unexpected = exits.filter((exit) => exit.code !== 0)
const invocations = store?.invocations ?? []
const ids = new Set(invocations.map((item) => item.id))
const expectedIds = new Set(Array.from({ length: workers }, (_, index) => `invocation-${index}`))
const residue = []
for (const suffix of ['.lock', '.tmp']) if (existsSync(`${storePath}${suffix}`)) residue.push(`${storePath}${suffix}`)
const status = unexpected.length === 0 && successful.length === workers && store?.revision === workers &&
  invocations.length === workers && ids.size === workers && [...expectedIds].every((id) => ids.has(id)) && residue.length === 0 ? 'pass' : 'fail'
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  status,
  workers,
  jokerHome,
  storePath,
  counts: { successful: successful.length, unexpected: unexpected.length, invocations: invocations.length },
  store: store ? { revision: store.revision, ids: [...ids].sort() } : null,
  residue,
  exits
}
const reportPath = join(jokerHome, '.joker', 'generated-tools', 'qualification', 'persistence-report.json')
await import('node:fs/promises').then(({ mkdir }) => mkdir(join(jokerHome, '.joker', 'generated-tools', 'qualification'), { recursive: true }))
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ ...report, reportPath }, null, 2))
if (status !== 'pass') process.exitCode = 1
