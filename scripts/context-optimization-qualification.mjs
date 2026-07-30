import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const contextModule = await import(pathToFileURL(join(root, 'src', 'main', 'agent', 'context.ts')).href)
const fixtureNames = ['large-json', 'repeated-logs', 'long-coding', 'long-webread', 'mcp-list', 'subagent-report']
const args = new Map()
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index]
  if (!value.startsWith('--')) continue
  const [key, inline] = value.slice(2).split('=', 2)
  args.set(key, inline ?? (process.argv[index + 1]?.startsWith('--') ? true : process.argv[++index]))
}
const reportDir = resolve(String(args.get('report-dir') || join(tmpdir(), 'joker-context-qualification')))
const reportPath = resolve(String(args.get('report') || join(reportDir, 'context-optimization-qualification.json')))
const fixtures = await Promise.all(fixtureNames.map(async (name) => (await import(pathToFileURL(join(root, 'scripts', 'fixtures', 'context', `${name}.mjs`)).href)).default))

const summaryCalls = []
function deterministicSummaryModel({ fail = false } = {}) {
  return {
    specificationVersion: 'v3', provider: 'qualification', modelId: fail ? 'summary-failure' : 'deterministic-summary', supportedUrls: {},
    doGenerate: async ({ prompt }) => {
      summaryCalls.push({ fail, promptLength: JSON.stringify(prompt).length })
      if (fail) throw new Error('QUALIFICATION_SUMMARY_FAILURE')
      const source = JSON.stringify(prompt)
      const protectedValues = fixtures.flatMap((fixture) => fixture.sentinels).filter((sentinel) => source.includes(sentinel))
      const text = `Deterministic checkpoint summary. Protected values: ${protectedValues.join(' | ')}. Decisions, paths, errors, identifiers, numbers, negative constraints, and open tasks remain authoritative.`
      return {
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: Math.ceil(source.length / 4), noCache: Math.ceil(source.length / 4), cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: Math.ceil(text.length / 4), text: Math.ceil(text.length / 4), reasoning: 0 }
        },
        response: { id: 'qualification-summary', modelId: 'deterministic-summary', timestamp: new Date(0) },
        content: [{ type: 'text', text }], warnings: []
      }
    },
    doStream: async () => { throw new Error('Qualification summary streaming is not expected') }
  }
}

function usageTokens(usage) {
  return {
    input: Number(usage?.inputTokens ?? 0),
    output: Number(usage?.outputTokens ?? 0),
    total: Number(usage?.totalTokens ?? ((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)))
  }
}
function projectedText(messages) { return JSON.stringify(messages) }
function sentinelResult(fixture, messages) {
  const text = projectedText(messages)
  const protectedSentinels = fixture.sentinels.map((sentinel) => ({ sentinel, protected: text.includes(sentinel) }))
  return { protectedSentinels, allProtected: protectedSentinels.every((item) => item.protected) }
}
function ratio(raw, projected, costs = 0) { return raw > 0 ? (raw - projected - costs) / raw : 0 }
function duration(startedAt) { return Math.round((performance.now() - startedAt) * 1000) / 1000 }
function normalizeV2Result(value, originalMessages) {
  if (!value || typeof value !== 'object') return null
  const messages = Array.isArray(value.messages) ? value.messages : Array.isArray(value.projectedMessages) ? value.projectedMessages : null
  if (!messages) return null
  const metrics = value.metrics && typeof value.metrics === 'object' ? value.metrics : {}
  return {
    messages,
    beforeTokens: Number(value.beforeTokens ?? metrics.originalTokens ?? contextModule.estimateContextTokens(originalMessages)),
    afterTokens: Number(value.afterTokens ?? metrics.projectedTokens ?? contextModule.estimateContextTokens(messages)),
    summaryInputTokens: Number(metrics.summaryInputTokens ?? usageTokens(value.usage).input),
    summaryOutputTokens: Number(metrics.summaryOutputTokens ?? usageTokens(value.usage).output),
    retrievalInputTokens: Number(metrics.retrievalInputTokens ?? 0),
    retrievalOutputTokens: Number(metrics.retrievalOutputTokens ?? 0),
    transformInputTokens: Number(metrics.transformInputTokens ?? 0),
    transformOutputTokens: Number(metrics.transformOutputTokens ?? 0),
    stepCount: Number(metrics.stepCount ?? value.stepCount ?? 1),
    durationMs: Number(metrics.durationMs ?? value.durationMs ?? 0),
    fallback: Boolean(value.fallback ?? metrics.fallback),
    error: value.error ?? metrics.error
  }
}
async function loadV2Compiler() {
  const candidates = [
    ['compileContextV2', contextModule.compileContextV2],
    ['compileContext', contextModule.compileContext],
    ['optimizeContext', contextModule.optimizeContext]
  ]
  for (const [name, compiler] of candidates) if (typeof compiler === 'function') return { name, compiler }
  for (const relative of ['src/main/agent/context-v2.ts', 'src/main/agent/context/compiler.ts', 'src/main/agent/context/index.ts']) {
    try {
      const loaded = await import(pathToFileURL(join(root, relative)).href)
      for (const name of ['compileContextV2', 'compileContext', 'optimizeContext']) {
        if (typeof loaded[name] === 'function') return { name: `${relative}#${name}`, compiler: loaded[name] }
      }
    } catch { /* Expected until the product-side v2 API lands. */ }
  }
  return null
}
async function invokeV2(v2, fixture) {
  const startedAt = performance.now()
  const value = await v2.compiler(fixture.messages, {
    mode: 'v2', sessionId: `qualification-${fixture.id}`, maxContextTokens: 24_000,
    outputTokenReserve: 2_000, model: deterministicSummaryModel(), policyVersion: 'qualification-v1'
  })
  const normalized = normalizeV2Result(value, fixture.messages)
  if (normalized && normalized.durationMs === 0) normalized.durationMs = duration(startedAt)
  return normalized
}

const v2Compiler = await loadV2Compiler()
const results = []
for (const fixture of fixtures) {
  const rawTokens = contextModule.estimateContextTokens(fixture.messages)
  const legacyStartedAt = performance.now()
  const legacy = await contextModule.compressContext(fixture.messages, {
    maxContextTokens: 24_000, outputTokenReserve: 2_000, model: deterministicSummaryModel()
  })
  const legacyUsage = usageTokens(legacy.usage)
  const legacyDurationMs = duration(legacyStartedAt)
  let v2 = null
  let v2AdapterError = null
  if (v2Compiler) {
    try { v2 = await invokeV2(v2Compiler, fixture) } catch (error) { v2AdapterError = error instanceof Error ? error.message : String(error) }
  }
  const effective = v2 ?? {
    messages: legacy.messages,
    beforeTokens: legacy.beforeTokens,
    afterTokens: legacy.afterTokens,
    summaryInputTokens: legacyUsage.input,
    summaryOutputTokens: legacyUsage.output,
    retrievalInputTokens: 0,
    retrievalOutputTokens: 0,
    transformInputTokens: 0,
    transformOutputTokens: 0,
    stepCount: 1,
    durationMs: legacyDurationMs,
    fallback: true,
    error: v2AdapterError ?? 'V2 compiler API unavailable; qualification used the explicit legacy fallback projection.'
  }
  const costs = effective.summaryInputTokens + effective.summaryOutputTokens + effective.retrievalInputTokens + effective.retrievalOutputTokens + effective.transformInputTokens + effective.transformOutputTokens
  const sentinel = sentinelResult(fixture, effective.messages)
  results.push({
    id: fixture.id,
    title: fixture.title,
    category: fixture.category,
    tokens: { raw: rawTokens, legacy: legacy.afterTokens, v2: effective.afterTokens },
    costs: {
      summary: { inputTokens: effective.summaryInputTokens, outputTokens: effective.summaryOutputTokens, totalTokens: effective.summaryInputTokens + effective.summaryOutputTokens },
      retrieval: { inputTokens: effective.retrievalInputTokens, outputTokens: effective.retrievalOutputTokens, totalTokens: effective.retrievalInputTokens + effective.retrievalOutputTokens },
      transform: { inputTokens: effective.transformInputTokens, outputTokens: effective.transformOutputTokens, totalTokens: effective.transformInputTokens + effective.transformOutputTokens }
    },
    stepCount: effective.stepCount,
    durationMs: { legacy: legacyDurationMs, v2: effective.durationMs },
    sentinel,
    estimatedNetSavedTokens: rawTokens - effective.afterTokens - costs,
    estimatedNetSavingRatio: ratio(rawTokens, effective.afterTokens, costs),
    minimumNetSavingRatio: fixture.minimumNetSavingRatio,
    modeApplied: v2 ? 'v2' : 'legacy-fallback',
    fallback: { applied: effective.fallback, reason: effective.error ?? null },
    originalMessagesUnchanged: projectedText(fixture.messages) === projectedText(fixtures.find((item) => item.id === fixture.id).messages)
  })
}

const shortMessages = [{ role: 'user', content: 'hello' }]
const shortBeforeCalls = summaryCalls.length
const shortResult = await contextModule.compressContext(shortMessages, { maxContextTokens: 24_000, outputTokenReserve: 2_000, model: deterministicSummaryModel() })
const shortSummaryCalls = summaryCalls.length - shortBeforeCalls

const fallbackMessages = fixtures.find((fixture) => fixture.id === 'large-json').messages
const fallbackResult = await contextModule.compressContext(fallbackMessages, { maxContextTokens: 24_000, outputTokenReserve: 2_000, model: deterministicSummaryModel({ fail: true }) })
const fallbackProjection = projectedText(fallbackResult.messages)
const fallbackProbe = {
  attempted: fallbackResult.attempted,
  compressed: fallbackResult.compressed,
  error: fallbackResult.error,
  originalMessagesUnchanged: !projectedText(fallbackMessages).includes('[tool output truncated for context]'),
  projectionHasFallbackMarker: fallbackProjection.includes('[tool output truncated for context]'),
  latestUserProtected: fallbackProjection.includes(String(fallbackMessages.at(-1)?.content ?? ''))
}

const gates = []
function gate(id, pass, expected, observed, blocking = true) { gates.push({ id, pass: Boolean(pass), blocking, expected, observed }) }
for (const id of ['large-json', 'repeated-logs']) {
  const item = results.find((result) => result.id === id)
  gate(`${id}-net-saving`, item.estimatedNetSavingRatio >= 0.30, 'estimated net saving >= 30%', item.estimatedNetSavingRatio)
}
const coding = results.find((result) => result.id === 'long-coding')
gate('long-coding-net-saving', coding.estimatedNetSavingRatio >= 0.15, 'estimated net saving >= 15%', coding.estimatedNetSavingRatio)
gate('all-protected-sentinels', results.every((result) => result.sentinel.allProtected), '100% protected sentinels retained', results.map((result) => ({ id: result.id, allProtected: result.sentinel.allProtected })))
gate('short-chat-summary-zero', shortSummaryCalls === 0 && shortResult.attempted === false, '0 summary calls and no compression attempt', { shortSummaryCalls, attempted: shortResult.attempted })
gate('deterministic-fallback', fallbackProbe.attempted && fallbackProbe.compressed && fallbackProbe.projectionHasFallbackMarker && fallbackProbe.latestUserProtected && /QUALIFICATION_SUMMARY_FAILURE/.test(fallbackProbe.error ?? ''), 'summary failure preserves originals/latest user and projects deterministic fallback', fallbackProbe)
gate('v2-api-integrated', Boolean(v2Compiler), 'product exports compileContextV2/compileContext/optimizeContext matching the adapter contract', v2Compiler?.name ?? 'not available', false)

const blockingFailures = gates.filter((item) => item.blocking && !item.pass)
const integrationPending = gates.some((item) => item.id === 'v2-api-integrated' && !item.pass)
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  command: process.argv.join(' '),
  status: blockingFailures.length > 0 ? 'fail' : integrationPending ? 'integration-pending' : 'pass',
  fixtureCount: results.length,
  v2Adapter: {
    detected: Boolean(v2Compiler),
    export: v2Compiler?.name ?? null,
    expectedContract: '(messages: ModelMessage[], { mode, sessionId, maxContextTokens, outputTokenReserve, model, policyVersion }) => { messages|projectedMessages, metrics?, usage?, fallback?, error? }'
  },
  fixtures: results,
  probes: { shortChat: { rawTokens: contextModule.estimateContextTokens(shortMessages), summaryCalls: shortSummaryCalls, attempted: shortResult.attempted }, fallback: fallbackProbe },
  gates,
  totals: {
    rawTokens: results.reduce((sum, result) => sum + result.tokens.raw, 0),
    legacyTokens: results.reduce((sum, result) => sum + result.tokens.legacy, 0),
    v2Tokens: results.reduce((sum, result) => sum + result.tokens.v2, 0),
    estimatedNetSavedTokens: results.reduce((sum, result) => sum + result.estimatedNetSavedTokens, 0),
    summaryCostTokens: results.reduce((sum, result) => sum + result.costs.summary.totalTokens, 0),
    retrievalCostTokens: results.reduce((sum, result) => sum + result.costs.retrieval.totalTokens, 0),
    transformCostTokens: results.reduce((sum, result) => sum + result.costs.transform.totalTokens, 0),
    stepCount: results.reduce((sum, result) => sum + result.stepCount, 0),
    durationMs: Math.round(results.reduce((sum, result) => sum + result.durationMs.v2, 0) * 1000) / 1000
  },
  notes: [
    'All token values are local estimates unless a future v2 compiler supplies measured metrics.',
    'estimatedNetSavedTokens subtracts projected input plus summary/retrieval/transform token costs from raw input.',
    'integration-pending is not a smoke pass: it means mechanical legacy/fallback gates passed but the product-side v2 compiler contract is not available.'
  ]
}
await mkdir(reportDir, { recursive: true })
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ reportPath, status: report.status, totals: report.totals, gates }, null, 2))
if (report.status === 'fail') process.exitCode = 1
