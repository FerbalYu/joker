import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
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
const workers = Math.max(2, Number(args.get('workers') ?? 4))
const rounds = Math.max(1, Number(args.get('rounds') ?? 50))
const keep = args.has('keep')
const runDir = await mkdtemp(join(tmpdir(), 'joker-session-concurrency-'))
const dataDir = join(runDir, 'sessions')
const reportPath = join(runDir, 'session-concurrency-report.json')
const sessionId = 'concurrency-seed-session'
const workerPath = join(root, '.qa', 'session-concurrency-worker.mjs')
const workerOutputs = []
const children = []

await import('node:fs/promises').then(async ({ mkdir }) => mkdir(dataDir, { recursive: true }))
const seed = { schemaVersion: 1, data: { id: sessionId, title: 'Concurrency seed', createdAt: Date.now(), updatedAt: Date.now(), messages: [] } }
await writeFile(join(dataDir, `${sessionId}.json`), `${JSON.stringify(seed, null, 2)}\n`, 'utf8')

function parseLines(text) {
  return text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}
function overlap(records) {
  const intervals = records.filter((record) => record.result).sort((a, b) => a.startedAt - b.startedAt)
  for (let i = 0; i < intervals.length; i += 1) {
    for (let j = i + 1; j < intervals.length; j += 1) {
      if (intervals[j].startedAt < intervals[i].finishedAt && intervals[j].finishedAt > intervals[i].startedAt) return true
    }
  }
  return false
}

for (let index = 0; index < workers; index += 1) {
  const child = spawn(process.execPath, ['--import=tsx', workerPath, dataDir, sessionId, String(index), String(rounds)], { cwd: root, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const output = { workerId: String(index), pid: child.pid, stdout: '', stderr: '' }
  child.stdout.on('data', (chunk) => { output.stdout += String(chunk) })
  child.stderr.on('data', (chunk) => { output.stderr += String(chunk) })
  children.push({ child, output })
  workerOutputs.push(output)
}
await Promise.all(children.map(({ child }) => new Promise((resolvePromise, reject) => {
  const timer = setTimeout(() => reject(new Error('worker readiness timeout')), 10_000)
  const onData = () => {
    if (!workerOutputs.find((item) => item.pid === child.pid)?.stdout.includes('READY')) return
    clearTimeout(timer)
    child.stdout.off('data', onData)
    resolvePromise()
  }
  child.stdout.on('data', onData)
})))
for (const { child } of children) child.stdin.write('GO\n')
const exits = await Promise.all(children.map(({ child }) => new Promise((resolvePromise) => child.once('exit', (code, signal) => resolvePromise({ code, signal })))))

const records = workerOutputs.flatMap((output) => parseLines(output.stdout))
const acknowledged = records.filter((record) => record.result === true)
const finalPath = join(dataDir, `${sessionId}.json`)
const backupPath = `${finalPath}.bak`
let primary = null
let backup = null
try { primary = JSON.parse(await readFile(finalPath, 'utf8')) } catch {}
try { backup = JSON.parse(await readFile(backupPath, 'utf8')) } catch {}
const finalMessages = primary?.data?.messages ?? []
const finalIds = new Set(finalMessages.map((message) => message.id))
const missingAcknowledged = acknowledged.map((record) => record.messageId).filter((id) => !finalIds.has(id))
const files = await readdir(dataDir)
const tempFiles = files.filter((file) => file.endsWith('.tmp'))
const lockFiles = files.filter((file) => file.endsWith('.lock') || file.endsWith('.lock.tmp'))
const validEnvelope = primary?.schemaVersion === 1 && primary?.data?.id === sessionId && Array.isArray(primary?.data?.messages)
const backupValid = backup === null || (backup.schemaVersion === 1 && backup.data?.id === sessionId && Array.isArray(backup.data?.messages))
const observedOverlap = overlap(records)
const failed = missingAcknowledged.length > 0 || exits.some((exit) => exit.code !== 0) || !validEnvelope || !backupValid || tempFiles.length > 0 || lockFiles.length > 0 || records.some((record) => record.error)
const status = failed ? 'fail' : observedOverlap ? 'pass' : 'inconclusive'
const report = {
  generatedAt: new Date().toISOString(),
  command: process.argv.slice(1).join(' '),
  node: process.version,
  platform: process.platform,
  runDir,
  dataDir,
  sessionId,
  configuration: { workers, rounds, keep },
  status,
  observedOverlap,
  counts: { workers, acknowledged: acknowledged.length, finalMessages: finalMessages.length, missingAcknowledged: missingAcknowledged.length },
  missingAcknowledged,
  exits,
  records,
  workerOutputs,
  validation: { validEnvelope, backupValid, tempFiles, lockFiles, files, primaryMessageCount: finalMessages.length },
  limitations: ['The session store serializes each session mutation with a cross-process lock directory and retains atomic temp/backup recovery. This qualification proves concurrent append preservation for the exercised workload; it does not extend the guarantee to unrelated config/project/image stores or stale full-snapshot replacement semantics.'],
  cleanup: { performed: !keep, status: keep ? 'retained-for-inspection' : 'pending' }
}
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
if (!keep) {
  await rm(runDir, { recursive: true, force: true })
  console.log(JSON.stringify({ reportPath, status, note: 'Report path is retained in output metadata; run directory cleanup was requested.' }, null, 2))
} else {
  console.log(JSON.stringify({ reportPath, runDir, status, counts: report.counts }, null, 2))
}
if (status === 'fail') process.exitCode = 1
