const SENTINELS = [
  'https://docs.example.test/context-policy#retention',
  'published=2026-07-29',
  'retention_days=30',
  'NOT authorized for cross-session access',
  'quote_id=Q-9017'
]

const sections = Array.from({ length: 180 }, (_, index) => `## Section ${index + 1}\nThe deterministic policy discussion covers context lifecycle, audit evidence, and bounded retrieval. ${'Supporting prose is intentionally verbose but stable across runs. '.repeat(14)}`)
sections.splice(93, 0, '## Retention exception\npublished=2026-07-29\nretention_days=30\nquote_id=Q-9017\nContext retrieval is NOT authorized for cross-session access.')
const output = `# Context Policy\nSource: https://docs.example.test/context-policy#retention\n\n${sections.join('\n\n')}`

export default {
  id: 'long-webread',
  title: 'Long WebRead policy document',
  category: 'long-webread',
  minimumNetSavingRatio: 0,
  sentinels: SENTINELS,
  messages: [
    { role: 'user', content: 'Read the policy and preserve URL, publication date, exact quotation identifiers, numbers, and negative authorization conditions.' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-webread', toolName: 'WebRead', input: { url: 'https://docs.example.test/context-policy#retention' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-webread', toolName: 'WebRead', output: { type: 'text', value: output } }] },
    { role: 'user', content: 'Apply published=2026-07-29, retention_days=30, quote_id=Q-9017, and the rule: NOT authorized for cross-session access.' }
  ]
}
