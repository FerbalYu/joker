import { proposeGeneratedToolInvocation } from '../../src/main/generated-tools/invocation-store.ts'

const [, , jokerHome, workerId] = process.argv
if (!jokerHome || !workerId) throw new Error('worker arguments are required')

function run() {
  const id = `invocation-${workerId}`
  const invocation = proposeGeneratedToolInvocation(jokerHome, {
    id,
    idempotencyKey: `qualification-${workerId}`,
    toolId: 'concurrent-tool',
    versionId: 'version-1',
    fingerprint: 'a'.repeat(64),
    sessionId: `session-${workerId}`,
    runId: `run-${workerId}`,
    toolCallId: `call-${workerId}`,
    capabilityRevision: 1,
    request: { workerId },
    proposedAt: 1
  })
  process.stdout.write(`${JSON.stringify({ workerId, result: 'persisted', invocationId: invocation.id })}\n`)
  process.exit(0)
}

process.stdout.write(`READY ${workerId} ${process.pid}\n`)
process.stdin.setEncoding('utf8')
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  if (buffer.includes('GO\n')) run()
})
