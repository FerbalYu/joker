const SENTINELS = [
  'ERR_JSON_7391',
  'customer_id=acct_000042',
  'status=denied',
  'retry_after_ms=2750',
  'must_not_delete=true'
]

const records = Array.from({ length: 900 }, (_, index) => ({
  id: `row-${String(index).padStart(4, '0')}`,
  customerId: index === 417 ? 'acct_000042' : `acct_${String(index % 30).padStart(6, '0')}`,
  status: index === 417 ? 'denied' : 'ok',
  region: ['ap-south', 'eu-west', 'us-east'][index % 3],
  attempts: index % 4,
  payload: {
    category: `category-${index % 8}`,
    enabled: index % 5 !== 0,
    repeatedDescription: 'deterministic qualification payload with intentionally repeated fields'
  },
  ...(index === 417 ? { errorCode: 'ERR_JSON_7391', retryAfterMs: 2750, mustNotDelete: true } : {})
}))

const output = JSON.stringify({ schemaVersion: 3, total: records.length, records }, null, 2)

export default {
  id: 'large-json',
  title: 'Large repetitive JSON tool result',
  category: 'large-json',
  minimumNetSavingRatio: 0.30,
  sentinels: SENTINELS,
  messages: [
    { role: 'user', content: 'Inspect the JSON export. Preserve the denied outlier, exact identifiers, numbers, and negative constraints.' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-large-json', toolName: 'McpInventory', input: { scope: 'qualification' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-large-json', toolName: 'McpInventory', output: { type: 'text', value: output } }] },
    { role: 'user', content: 'Explain ERR_JSON_7391 for customer_id=acct_000042; status=denied; retry_after_ms=2750; must_not_delete=true.' }
  ]
}
