const SENTINELS = [
  'CONTEXT_SENTINEL_CODING_5519',
  'E:\\joker\\src\\main\\agent\\loop.ts:86',
  'compileContextV2',
  'checkpointGeneration=12',
  'must_not_mutate_session=true'
]

const history = []
for (let turn = 0; turn < 54; turn += 1) {
  const file = turn % 2 === 0 ? 'src/main/agent/context.ts' : 'src/main/agent/loop.ts'
  history.push({ role: 'user', content: `Turn ${turn}: inspect ${file}, preserve tool pairing, and continue the context compiler implementation. ${'constraint detail '.repeat(45)}` })
  history.push({ role: 'assistant', content: `Turn ${turn} finding: ${file} requires a surgical change. Decision D-${String(turn).padStart(3, '0')} remains active. ${'implementation evidence '.repeat(55)}` })
}

export default {
  id: 'long-coding',
  title: 'Long coding conversation with stable decisions',
  category: 'long-coding',
  minimumNetSavingRatio: 0.15,
  sentinels: SENTINELS,
  messages: [
    ...history,
    { role: 'assistant', content: 'Protected checkpoint: CONTEXT_SENTINEL_CODING_5519; API compileContextV2; checkpointGeneration=12; must_not_mutate_session=true; location E:\\joker\\src\\main\\agent\\loop.ts:86.' },
    { role: 'user', content: 'Finish compileContextV2 without changing Session originals. Keep CONTEXT_SENTINEL_CODING_5519, E:\\joker\\src\\main\\agent\\loop.ts:86, checkpointGeneration=12, and must_not_mutate_session=true.' }
  ]
}
