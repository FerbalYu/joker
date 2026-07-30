import { appendMessage, getSession, setSessionsDataDirForTests } from '../src/main/store/sessions.ts'

const [, , dataDir, sessionId, workerId, roundsText] = process.argv
if (!dataDir || !sessionId || !workerId || !roundsText) throw new Error('worker arguments are required')
setSessionsDataDirForTests(dataDir)

function message(round) {
  const id = `worker-${workerId}-round-${round}`
  return { id, role: 'user', content: `${id} ${'x'.repeat(1024)}`, createdAt: Date.now() }
}

function run() {
  const rounds = Math.max(1, Number.parseInt(roundsText, 10))
  for (let round = 0; round < rounds; round += 1) {
    const item = message(round)
    const startedAt = Date.now()
    let result = false
    let error
    try {
      result = appendMessage(sessionId, item)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }
    const record = { workerId, pid: process.pid, messageId: item.id, startedAt, finishedAt: Date.now(), result, error }
    process.stdout.write(`${JSON.stringify(record)}\n`)
  }
  process.exit(0)
}

if (!getSession(sessionId)) throw new Error('seed session is missing')
process.stdout.write(`READY ${workerId} ${process.pid}\n`)
process.stdin.setEncoding('utf8')
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  if (buffer.includes('GO\n')) run()
})
