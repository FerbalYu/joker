const SENTINELS = [
  'ERR_BUILD_8421',
  'E:\\joker\\src\\main\\agent\\context.ts:247',
  'request_id=req-log-00077',
  'exit_code=17',
  'do_not_retry=true'
]

const lines = []
for (let index = 0; index < 2200; index += 1) {
  lines.push(`2026-07-30T10:${String(Math.floor(index / 60) % 60).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z INFO worker=compile shard=${index % 12} state=heartbeat queue_depth=${index % 5}`)
  if (index % 73 === 0) lines.push(`2026-07-30T10:20:00.000Z WARN worker=compile state=backpressure retry_in_ms=${100 + index}`)
}
lines.splice(1377, 0,
  '2026-07-30T10:22:57.000Z ERROR code=ERR_BUILD_8421 request_id=req-log-00077 exit_code=17 do_not_retry=true',
  '    at compileContext (E:\\joker\\src\\main\\agent\\context.ts:247:13)',
  '    at async runQualification (E:\\joker\\scripts\\context-optimization-qualification.mjs:1:1)'
)

export default {
  id: 'repeated-logs',
  title: 'Repeated build log with one protected failure',
  category: 'repeated-logs',
  minimumNetSavingRatio: 0.30,
  sentinels: SENTINELS,
  messages: [
    { role: 'user', content: 'Diagnose the repeated build log. Preserve errors, stack locations, request IDs, exit codes, and negative retry constraints.' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-repeated-log', toolName: 'Bash', input: { command: 'npm run build' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-repeated-log', toolName: 'Bash', output: { type: 'text', value: lines.join('\n') } }] },
    { role: 'user', content: 'Resolve ERR_BUILD_8421 at E:\\joker\\src\\main\\agent\\context.ts:247 for request_id=req-log-00077, exit_code=17, do_not_retry=true.' }
  ]
}
