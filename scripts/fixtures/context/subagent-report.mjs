const SENTINELS = [
  'agent_run_id=subagent-0091',
  'open_task=wire_context_retrieve',
  'failed_attempt=checkpoint_hash_v0',
  'evidence=E:\\joker\\src\\main\\store\\sessions.ts:301',
  'must_not_claim_smoke_passed=true'
]

const findings = Array.from({ length: 260 }, (_, index) => `Finding ${String(index).padStart(3, '0')}: deterministic evidence item for context optimization qualification. ${'Repeated supporting analysis. '.repeat(10)}`)
findings.splice(171, 0, 'Critical handoff: agent_run_id=subagent-0091; open_task=wire_context_retrieve; failed_attempt=checkpoint_hash_v0; evidence=E:\\joker\\src\\main\\store\\sessions.ts:301; must_not_claim_smoke_passed=true.')
const output = `Goal: validate context optimization integration\nConfirmed facts:\n${findings.join('\n')}\nOpen tasks:\n- wire ContextRetrieve\n- preserve session originals`

export default {
  id: 'subagent-report',
  title: 'Long sub-agent handoff report',
  category: 'subagent-report',
  minimumNetSavingRatio: 0,
  sentinels: SENTINELS,
  messages: [
    { role: 'user', content: 'Consume the sub-agent report while preserving open tasks, failures, evidence paths, and qualification caveats.' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-subagent-report', toolName: 'Agent', input: { task: 'context optimization audit' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-subagent-report', toolName: 'Agent', output: { type: 'text', value: output } }] },
    { role: 'user', content: 'Continue agent_run_id=subagent-0091 with open_task=wire_context_retrieve. Record failed_attempt=checkpoint_hash_v0, evidence=E:\\joker\\src\\main\\store\\sessions.ts:301, and must_not_claim_smoke_passed=true.' }
  ]
}
