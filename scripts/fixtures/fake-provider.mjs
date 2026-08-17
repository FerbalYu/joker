import http from 'node:http'
import fs from 'node:fs'

const port = Number(process.env.PORT || 18765)
const logPath = process.env.LOG_PATH || '.qa/fake-provider.log'
const scenario = process.env.JOKER_FAKE_SCENARIO || 'default'
const requests = []
const GENERATED_IMAGE_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVR4nGP4z8DAAMJgAsQAACnoA/2tJ5gCAAAAAElFTkSuQmCC'

function writeLog(entry) {
  requests.push(entry)
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n')
}

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function streamResponse(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  res.end('data: [DONE]\n\n')
}

function toolCall(name, args, id) {
  return [
    { id: 'chatcmpl-qa', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'gpt-4o', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] }, finish_reason: null }] },
    { id: 'chatcmpl-qa', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'gpt-4o', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
    { id: 'chatcmpl-qa', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'gpt-4o', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 480, completion_tokens: 22, total_tokens: 502, prompt_tokens_details: { cached_tokens: 320 } } }
  ]
}

function textResponse(text) {
  return [
    { id: 'chatcmpl-qa', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'gpt-4o', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
    { id: 'chatcmpl-qa', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'gpt-4o', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 520, completion_tokens: 28, total_tokens: 548, prompt_tokens_details: { cached_tokens: 300 } } }
  ]
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function delayedStreamResponse(res, chunks, delayMs, initialDelayMs = 0) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  if (initialDelayMs > 0) await sleep(initialDelayMs)
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    await sleep(delayMs)
  }
  res.end('data: [DONE]\n\n')
}

const RESEARCH_CALLS = {
  TodoWrite: 'call_research_todo',
  WebSearch: 'call_research_search',
  WebRead: 'call_research_read',
  PresentResearchReport: 'call_research_report'
}

function researchToolHistory(messages) {
  const calls = new Map()
  const results = new Map()
  for (const message of messages) {
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const name = call?.function?.name
        if (typeof call?.id === 'string' && typeof name === 'string') calls.set(call.id, name)
      }
    }
    if (message?.role === 'tool' && typeof message.tool_call_id === 'string') {
      results.set(message.tool_call_id, String(message.content ?? ''))
    }
  }
  return { calls, results }
}

function completedResearchTool(history, name) {
  const id = RESEARCH_CALLS[name]
  return history.calls.get(id) === name && history.results.has(id)
}

function researchResponse(messages) {
  const history = researchToolHistory(messages)
  if (!completedResearchTool(history, 'TodoWrite')) {
    return toolCall('TodoWrite', {
      todos: [
        { content: 'Search for the Example Domain source', status: 'in_progress', priority: 'high' },
        { content: 'Read and verify the primary page', status: 'pending', priority: 'high' },
        { content: 'Present the cited research report', status: 'pending', priority: 'medium' }
      ]
    }, RESEARCH_CALLS.TodoWrite)
  }
  if (!completedResearchTool(history, 'WebSearch')) {
    return toolCall('WebSearch', { query: 'Example Domain example.com', limit: 5, timeoutMs: 20000 }, RESEARCH_CALLS.WebSearch)
  }
  if (!completedResearchTool(history, 'WebRead')) {
    return toolCall('WebRead', { url: 'https://example.com', timeoutMs: 30000, maxChars: 5000 }, RESEARCH_CALLS.WebRead)
  }
  if (!completedResearchTool(history, 'PresentResearchReport')) {
    return toolCall('PresentResearchReport', {
      title: 'Example Domain Deterministic Research Report',
      summary: 'A deterministic end-to-end report based on the public Example Domain page.',
      sections: [
        {
          heading: 'Purpose and identity',
          paragraphs: [{
            text: 'The page identifies itself as the Example Domain and provides a stable public target for documentation examples.',
            citations: [{ sourceId: 'S1', quote: 'Example Domain' }]
          }]
        },
        {
          heading: 'Smoke-test evidence',
          paragraphs: [{
            text: 'The verified page supports exercising web reading, authoritative source metadata, compact citations, and persisted report rendering.',
            citations: [{ sourceId: 'S1', quote: 'Example Domain' }]
          }]
        }
      ],
      charts: [{
        type: 'bar',
        title: '公开网页深度研究流程中的确定性验证产物、权威来源引用、数据图表与会话持久化结果完整统计',
        xLabel: '验证产物名称（包含来源、章节、引用与图表持久化状态）',
        yLabel: '已完成并通过校验的项目数量（项）',
        sourceIds: ['S1'],
        data: [
          { label: '已验证公开来源', value: 1 },
          { label: '报告章节', value: 2 },
          { label: '紧凑引用', value: 2 },
          { label: '持久化图表', value: 1 },
          { label: '可下载报告', value: 1 }
        ]
      }]
    }, RESEARCH_CALLS.PresentResearchReport)
  }
  return textResponse('Research report completed and persisted.')
}

const TOOL_LIFECYCLE_CALLS = {
  First: 'call_lifecycle_first',
  Second: 'call_lifecycle_second',
  Third: 'call_lifecycle_third'
}

const QUEUE_STEER_CALL = 'call_queue_steer_read'
const QUEUE_STEER_BRIDGE_CALL = 'call_queue_steer_bridge'
const MULTI_SESSION_CALLS = {
  A: 'call_multi_session_a',
  B: 'call_multi_session_b',
  StopA: 'call_multi_session_stop_a',
  StopB: 'call_multi_session_stop_b'
}

function userMessageText(message) {
  if (typeof message?.content === 'string') return message.content
  if (!Array.isArray(message?.content)) return ''
  return message.content
    .filter((part) => part?.type === 'text')
    .map((part) => String(part.text ?? ''))
    .join('')
}

function queueSteerResponse(messages) {
  const history = researchToolHistory(messages)
  const userTexts = messages.filter((message) => message?.role === 'user').map(userMessageText)
  const latestUserText = userTexts.at(-1) ?? ''
  if (latestUserText.includes('STEER_CURRENT_7781')) {
    return textResponse('STEER_CURRENT_APPLIED_7781')
  }
  if (latestUserText.includes('QUEUE_FOLLOWUP_7781')) {
    return textResponse('QUEUE_FOLLOWUP_APPLIED_7781')
  }
  if (history.calls.get(QUEUE_STEER_CALL) === 'Write' && history.results.has(QUEUE_STEER_CALL)) {
    if (!(history.calls.get(QUEUE_STEER_BRIDGE_CALL) === 'Read' && history.results.has(QUEUE_STEER_BRIDGE_CALL))) {
      return toolCall('Read', { filePath: 'queue-steer-bridge.txt' }, QUEUE_STEER_BRIDGE_CALL)
    }
    return textResponse('QUEUE_STEER_BASE_COMPLETED_7781')
  }
  return toolCall('Write', { filePath: 'queue-steer-approval.txt', content: 'approval boundary only' }, QUEUE_STEER_CALL)
}

function multiSessionResponse(messages) {
  const history = researchToolHistory(messages)
  const userTexts = messages.filter((message) => message?.role === 'user').map(userMessageText)
  const prompt = userTexts.at(-1) ?? ''
  const marker = prompt.includes('MULTI_SESSION_A_7781')
    ? 'A'
    : prompt.includes('MULTI_SESSION_B_7781')
      ? 'B'
      : prompt.includes('MULTI_SESSION_STOP_A_7781')
        ? 'StopA'
        : 'StopB'
  const callId = MULTI_SESSION_CALLS[marker]
  if (!(history.calls.get(callId) === 'Write' && history.results.has(callId))) {
    return toolCall('Write', { filePath: `multi-session-${marker.toLowerCase()}.txt`, content: 'approval boundary only' }, callId)
  }
  return textResponse(`MULTI_SESSION_${marker === 'StopA' ? 'STOP_A' : marker === 'StopB' ? 'STOP_B' : marker}_COMPLETED_7781`)
}

function toolLifecycleResponse(messages) {
  const history = researchToolHistory(messages)
  if (!(history.calls.get(TOOL_LIFECYCLE_CALLS.First) === 'Read' && history.results.has(TOOL_LIFECYCLE_CALLS.First))) {
    return toolCall('Read', { filePath: 'package.json' }, TOOL_LIFECYCLE_CALLS.First)
  }
  if (!(history.calls.get(TOOL_LIFECYCLE_CALLS.Second) === 'GitStatus' && history.results.has(TOOL_LIFECYCLE_CALLS.Second))) {
    return toolCall('GitStatus', {}, TOOL_LIFECYCLE_CALLS.Second)
  }
  if (!(history.calls.get(TOOL_LIFECYCLE_CALLS.Third) === 'GitLog' && history.results.has(TOOL_LIFECYCLE_CALLS.Third))) {
    return toolCall('GitLog', { count: 1 }, TOOL_LIFECYCLE_CALLS.Third)
  }
  return textResponse('Tool lifecycle smoke completed.')
}

const CONTEXT_RETRIEVE_CALL = 'call_context_retrieve_qa'

const ASK_QUESTION_CALL = 'call_ask_user_qa'

const PRODUCED_FILES_CALLS = { First: 'call_pf_write', Second: 'call_pf_edit' }

function producedFilesResponse(messages) {
  const history = researchToolHistory(messages)
  if (history.calls.get(PRODUCED_FILES_CALLS.First) === 'Write' && history.results.has(PRODUCED_FILES_CALLS.First) &&
      history.calls.get(PRODUCED_FILES_CALLS.Second) === 'Edit' && history.results.has(PRODUCED_FILES_CALLS.Second)) {
    return textResponse('Produced-files QA completed: notes.txt was created and config.md was edited.')
  }
  if (!(history.calls.get(PRODUCED_FILES_CALLS.First) === 'Write' && history.results.has(PRODUCED_FILES_CALLS.First))) {
    return toolCall('Write', { filePath: 'notes.txt', content: 'produced-files fixture line 1\nline 2\n' }, PRODUCED_FILES_CALLS.First)
  }
  return toolCall('Edit', { filePath: 'config.md', oldString: 'line 2', newString: 'line 2 edited' }, PRODUCED_FILES_CALLS.Second)
}

function askQuestionResponse(messages) {
  const history = researchToolHistory(messages)
  if (history.calls.get(ASK_QUESTION_CALL) === 'AskUserQuestion' && history.results.has(ASK_QUESTION_CALL)) {
    const answer = String(history.results.get(ASK_QUESTION_CALL) ?? '')
    if (answer.includes('dismissed')) return textResponse('AskUserQuestion dismissed by the user; continuing with the safest option.')
    return textResponse(`AskUserQuestion round trip completed. The user chose: ${answer.includes('Fast') ? 'Fast mode' : 'another answer'}.`)
  }
  return toolCall('AskUserQuestion', {
    questions: [{
      question: 'ASK_QUESTION_7781: Which release strategy should the migration use?',
      header: 'Choose mode',
      multiSelect: false,
      options: [
        { label: 'Fast mode', description: 'Ship immediately with minimal validation.' },
        { label: 'Safe mode', description: 'Run the full verification suite first.' }
      ],
      allowFreeText: true
    }]
  }, ASK_QUESTION_CALL)
}

function contextOptimizationResponse(messages, tools) {
  const history = researchToolHistory(messages)
  if (history.calls.get(CONTEXT_RETRIEVE_CALL) === 'ContextRetrieve' && history.results.has(CONTEXT_RETRIEVE_CALL)) {
    return textResponse('Context optimization retrieval completed with the protected original evidence.')
  }
  const toolNames = Array.isArray(tools) ? tools.map((tool) => tool?.function?.name).filter(Boolean) : []
  if (!toolNames.includes('ContextRetrieve')) {
    return textResponse('CONTEXT_OPTIMIZATION_INTEGRATION_PENDING: ContextRetrieve is not exposed by the product tool registry.')
  }
  const serialized = JSON.stringify(messages)
  const contextId = serialized.match(/contextId["'=: ]+([A-Za-z0-9._:-]+)/)?.[1] ?? 'ctx_qa_current_session'
  return toolCall('ContextRetrieve', { contextId, keyword: 'CONTEXT_ELECTRON_SENTINEL_7781', maxChars: 12000 }, CONTEXT_RETRIEVE_CALL)
}

function planResponse(messages) {
  const history = researchToolHistory(messages)
  const planCallId = 'call_plan_todo'
  if (!(history.calls.get(planCallId) === 'TodoWrite' && history.results.has(planCallId))) {
    return toolCall('TodoWrite', {
      todos: [
        { content: 'Inspect the relevant repository context', status: 'in_progress', priority: 'high' },
        { content: 'Describe the ordered implementation steps', status: 'pending', priority: 'high' },
        { content: 'List the validation gates', status: 'pending', priority: 'medium' }
      ]
    }, planCallId)
  }
  return textResponse('Plan created without implementing changes.')
}

function goalEvaluationResponse(messages) {
  const payloadMessage = [...messages].reverse().find((message) => message.role === 'user')
  let payload = {}
  try { payload = JSON.parse(String(payloadMessage?.content ?? '{}')) } catch { /* schema failure response below */ }
  const executionMessage = payload.executionMessage ?? {}
  const round = Number(payload.round ?? 1)
  const complete = round >= 2
  const quote = complete
    ? 'Goal evidence: corrected Slash command flow verified in round 2.'
    : 'Goal evidence: corrected Slash command flow needs a second verification round.'
  return {
    id: 'chatcmpl-goal-evaluation',
    object: 'chat.completion',
    model: 'gpt-4o',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: JSON.stringify({
          decision: complete ? 'complete' : 'continue',
          criteria: [{ criterion: 'The corrected Slash command flow is verified in a second round', satisfied: complete }],
          evidenceReferences: complete ? [{
            source: 'assistant_quote',
            generation: payload.generation,
            round: payload.round,
            messageId: executionMessage.id,
            quote
          }] : [],
          unmetCriteria: complete ? [] : ['The corrected Slash command flow needs a second verification round'],
          nextFeedback: complete ? '' : 'Run a second verification round and provide final evidence.'
        })
      },
      finish_reason: 'stop'
    }],
    usage: { prompt_tokens: 90, completion_tokens: 35, total_tokens: 125 }
  }
}

function compactSummaryResponse() {
  return {
    id: 'chatcmpl-compact',
    object: 'chat.completion',
    model: 'gpt-4o',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: JSON.stringify({
          confirmedFacts: ['Slash+ exposes goal, plan, compact, and Skills.'],
          decisions: ['Preserve original session messages during compaction.'],
          filesRead: [],
          changesMade: [],
          failedAttempts: [],
          openTasks: ['Continue with the latest user request.'],
          criticalIdentifiers: ['SESSION_GOAL', 'DEFAULT_CONTEXT_POLICY_VERSION']
        })
      },
      finish_reason: 'stop'
    }],
    usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 }
  }
}

function toolForgeVerticalHistory(messages) {
  const history = researchToolHistory(messages)
  const calls = []
  for (const message of messages) {
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue
    for (const call of message.tool_calls) {
      const name = call?.function?.name
      if (typeof name === 'string') {
        let args = {}
        try { args = JSON.parse(String(call.function.arguments ?? '{}')) } catch { /* host reports malformed input */ }
        calls.push({ id: call.id, name, args })
      }
    }
  }
  return { ...history, calls }
}

function completedTool(history, name) {
  return history.calls.some((call) => call.name === name && history.results.has(call.id))
}

function latestToolCall(history, name) {
  return [...history.calls].reverse().find((call) => call.name === name)
}

function latestToolResult(messages, history, name) {
  const call = latestToolCall(history, name)
  return call ? history.results.get(call.id) ?? '' : ''
}

function parseToolJson(messages, history, name) {
  const raw = latestToolResult(messages, history, name)
  if (!raw) return {}
  try {
    const outer = JSON.parse(raw)
    const value = outer && typeof outer === 'object' && 'output' in outer ? outer.output : outer
    return typeof value === 'string' ? JSON.parse(value) : value
  } catch {
    return {}
  }
}

const ELECTRON_TOOLFORGE_TOOL_ID = 'electron-vertical-slice-task-summary'
const ELECTRON_TOOLFORGE_PROJECT_ID = 'electron-vertical-slice-project'
const ELECTRON_TOOLFORGE_CALLS = {
  search: 'call_electron_tool_search',
  start: 'call_electron_tool_forge_start'
}

const ELECTRON_TOOLFORGE_MANIFEST = {
  schemaVersion: 1,
  toolId: ELECTRON_TOOLFORGE_TOOL_ID,
  displayName: 'ElectronVerticalSliceTaskSummary',
  description: 'Reads project task JSON and returns deterministic status counts.',
  sdkVersion: '1.0.0',
  runtime: { id: 'quickjs-wasm', version: '0.32.0' },
  entrypoint: 'source/tool.js',
  inputSchema: { type: 'object', additionalProperties: false },
  outputSchema: { type: 'string' },
  errorContract: {
    type: 'object',
    properties: { message: { type: 'string' } },
    required: ['message'],
    additionalProperties: false
  },
  permissions: {
    filesystem: { read: ['fixtures/tasks.json'], write: [] },
    network: { hosts: [], methods: [] },
    process: { commands: [] },
    environment: { keys: [] },
    secrets: { handles: [] }
  },
  dependencies: [],
  limits: { timeoutMs: 1000, maxInputBytes: 4096, maxOutputBytes: 16384, maxMemoryBytes: 32000000 }
}

const ELECTRON_TOOLFORGE_SOURCE = `
function summarize(tasks) {
  const counts = {}
  for (const task of tasks) {
    const key = task && task.status ? String(task.status) : 'unknown'
    counts[key] = (counts[key] || 0) + 1
  }
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a] || (a < b ? -1 : a > b ? 1 : 0)).map((key) => key + ': ' + counts[key]).join('\\n')
}
try {
  const rows = JSON.parse(tool.readFile('fixtures/tasks.json'))
  if (!(rows instanceof Array)) tool.fail({ message: 'invalid-task-json' })
  else tool.output(summarize(rows))
} catch (error) {
  if (error && error.message === 'invalid-task-json') throw error
  tool.fail({ message: 'invalid-task-json' })
}
`

function electronEditSource(failure, attempt) {
  if (failure) return `tool.output('edited-invalid-attempt-${attempt}')
`
  return `${ELECTRON_TOOLFORGE_SOURCE}
// gate4-edit-success-attempt-${attempt}
`
}

function electronEditForgeAgentResponse(messages, failure) {
  const history = toolForgeVerticalHistory(messages)
  if (!completedTool(history, 'ForgeReadSpec')) return toolCall('ForgeReadSpec', {}, `call_electron_edit_read_spec_${failure ? 'failure' : 'success'}`)
  const spec = parseToolJson(messages, history, 'ForgeReadSpec')
  const attempt = Number(spec.forgeJobAttempt ?? 1)
  const source = electronEditSource(failure, attempt)
  const writes = history.calls.filter((call) => call.name === 'ForgeWriteFile' && history.results.has(call.id))
  if (writes.length < 2) {
    if (writes.length === 0) return toolCall('ForgeWriteFile', { path: 'source/tool.js', content: source }, `call_electron_edit_write_source_${attempt}`)
    return toolCall('ForgeWriteFile', { path: 'dist/tool.js', content: source }, `call_electron_edit_write_dist_${attempt}`)
  }
  if (!completedTool(history, 'ForgeRunCheck')) return toolCall('ForgeRunCheck', {}, `call_electron_edit_run_check_${attempt}`)
  if (!completedTool(history, 'ForgeSubmitCandidate')) {
    return toolCall('ForgeSubmitCandidate', {
      expectedRevision: Number(spec.forgeJobRevision ?? 2)
    }, `call_electron_edit_submit_${attempt}`)
  }
  return textResponse('Forge edit submitted for host verification and automatic enablement.')
}

function electronToolForgeEditResponse(messages, tools, systemText, failure) {
  if (/dedicated ToolForge manufacturing agent/i.test(systemText)) return electronEditForgeAgentResponse(messages, failure)
  const history = toolForgeVerticalHistory(messages)
  const generated = (Array.isArray(tools) ? tools : [])
    .map((tool) => tool?.function?.name)
    .find((name) => name === 'summarize-task-json')
  if (generated) {
    if (!history.calls.some((call) => call.name === generated && history.results.has(call.id))) {
      return toolCall(generated, {}, `call_electron_edit_stable_${failure ? 'failure' : 'success'}`)
    }
    return textResponse('The stable Generated Tool remains executable: open: 4\ndone: 3\nin_progress: 2')
  }
  return textResponse('Edit qualification provider is ready.')
}
function electronForgeAgentResponse(messages) {
  const history = toolForgeVerticalHistory(messages)
  if (!completedTool(history, 'ForgeReadSpec')) return toolCall('ForgeReadSpec', {}, 'call_electron_forge_read_spec')
  const spec = parseToolJson(messages, history, 'ForgeReadSpec')
  const attempt = Number(spec.forgeJobAttempt ?? 1)
  const source = attempt > 1
    ? `${ELECTRON_TOOLFORGE_SOURCE}\n// repair-attempt-${attempt}`
    : ELECTRON_TOOLFORGE_SOURCE
  const writes = history.calls.filter((call) => call.name === 'ForgeWriteFile' && history.results.has(call.id))
  if (writes.length < 3) {
    if (writes.length === 0) return toolCall('ForgeWriteFile', { path: 'manifest.json', content: JSON.stringify(ELECTRON_TOOLFORGE_MANIFEST, null, 2) + '\n' }, 'call_electron_forge_write_manifest')
    if (writes.length === 1) return toolCall('ForgeWriteFile', { path: 'source/tool.js', content: source }, 'call_electron_forge_write_source')
    return toolCall('ForgeWriteFile', { path: 'dist/tool.js', content: source }, 'call_electron_forge_write_dist')
  }
  if (!completedTool(history, 'ForgeRunCheck')) return toolCall('ForgeRunCheck', {}, 'call_electron_forge_run_check')
  if (!completedTool(history, 'ForgeSubmitCandidate')) {
    return toolCall('ForgeSubmitCandidate', {
      expectedRevision: Number(spec.forgeJobRevision ?? 2)
    }, 'call_electron_forge_submit')
  }
  return textResponse('Forge manufacturing submitted for host verification and automatic enablement.')
}

function electronToolForgeResponse(messages, tools, systemText) {
  const history = toolForgeVerticalHistory(messages)
  if (/dedicated ToolForge manufacturing agent/i.test(systemText)) return electronForgeAgentResponse(messages)
  if (/tool-forge-continuation/i.test(systemText)) {
    const generated = (Array.isArray(tools) ? tools : []).map((tool) => tool?.function?.name).find((name) => name === ELECTRON_TOOLFORGE_TOOL_ID)
    if (!generated) return textResponse('Continuation could not find the enabled Generated Tool.')
    if (!history.calls.some((call) => call.name === generated && history.results.has(call.id))) return toolCall(generated, {}, 'call_electron_generated_first_tool')
    return textResponse('Electron ToolForge vertical slice completed: open: 2\ndone: 1')
  }
  if (!completedTool(history, 'ToolSearch')) return toolCall('ToolSearch', { query: 'zzqelectronverticalslice91x' }, ELECTRON_TOOLFORGE_CALLS.search)
  if (!completedTool(history, 'ToolForgeStart')) {
    return toolCall('ToolForgeStart', {
      idempotencyKey: 'electron-toolforge-vertical-slice-start-1',
      mode: 'create',
      maxAttempts: 3,
      spec: {
        id: ELECTRON_TOOLFORGE_TOOL_ID,
        displayName: ELECTRON_TOOLFORGE_MANIFEST.displayName,
        goal: 'Read fixtures/tasks.json and return status counts.',
        reason: 'The current task needs deterministic project task summarization.',
        requestedBy: { sessionId: 'model-placeholder-session', runId: 'model-placeholder-run', userMessageId: 'model-placeholder-message' },
        scope: 'project',
        projectId: ELECTRON_TOOLFORGE_PROJECT_ID,
        inputContract: ELECTRON_TOOLFORGE_MANIFEST.inputSchema,
        outputContract: ELECTRON_TOOLFORGE_MANIFEST.outputSchema,
        permissions: ELECTRON_TOOLFORGE_MANIFEST.permissions,
        acceptance: ['Valid task JSON returns sorted status counts.', 'Invalid task JSON returns explicit invalid-task-json failure.'],
        examples: [{ input: {}, expected: 'open: 2\\ndone: 1' }]
      }
    }, ELECTRON_TOOLFORGE_CALLS.start)
  }
  return textResponse('ToolForge manufacturing started; the host will verify, enable, and continue the original task.')
}

const FS_OCC_MARKER = 'zzqfsocc41x'
const FS_OCC_CALLS = {
  Read: 'call_fs_occ_read',
  Write: 'call_fs_occ_write_stale',
  ReadAgain: 'call_fs_occ_read_again',
  Edit: 'call_fs_occ_edit'
}

function toolResultJson(content) {
  try {
    const parsed = JSON.parse(content)
    if (parsed && typeof parsed === 'object' && typeof parsed.output === 'string') return parsed
  } catch { /* not JSON */ }
  return null
}

function fsOccResponse(messages) {
  const history = researchToolHistory(messages)
  const done = (id) => history.calls.get(id) !== undefined && history.results.has(id)
  const resultOf = (id) => {
    const raw = String(history.results.get(id) ?? '')
    const parsed = toolResultJson(raw)
    return parsed ? parsed.output : raw
  }
  const versionOf = (id) => {
    const raw = String(history.results.get(id) ?? '')
    const parsed = toolResultJson(raw)
    return typeof parsed?.metadata?.version === 'string' ? parsed.metadata.version : undefined
  }
  if (!done(FS_OCC_CALLS.Read)) return toolCall('Read', { filePath: 'notes.txt' }, FS_OCC_CALLS.Read)
  if (!done(FS_OCC_CALLS.Write)) {
    const readVersion = versionOf(FS_OCC_CALLS.Read)
    if (!readVersion) return textResponse('FS_OCC_UNEXPECTED: initial Read did not expose a version digest.')
    return toolCall('Write', { filePath: 'notes.txt', content: 'colliding overwrite from stale snapshot', expectedVersion: readVersion.slice(0, 62) + '00' }, FS_OCC_CALLS.Write)
  }
  if (!resultOf(FS_OCC_CALLS.Write).includes('expectedVersion mismatch')) {
    return textResponse('FS_OCC_UNEXPECTED: stale Write unexpectedly succeeded; optimistic concurrency boundary is broken.')
  }
  if (!done(FS_OCC_CALLS.ReadAgain)) return toolCall('Read', { filePath: 'notes.txt' }, FS_OCC_CALLS.ReadAgain)
  if (!done(FS_OCC_CALLS.Edit)) {
    const fresh = versionOf(FS_OCC_CALLS.ReadAgain)
    if (!fresh) return textResponse('FS_OCC_UNEXPECTED: re-read tool result did not expose a version digest.')
    return toolCall('Edit', { filePath: 'notes.txt', oldString: 'stable initial content', newString: 'stable initial content, edited with expectedVersion', expectedVersion: fresh }, FS_OCC_CALLS.Edit)
  }
  if (!resultOf(FS_OCC_CALLS.Edit).includes('Edited notes.txt')) {
    return textResponse('FS_OCC_UNEXPECTED: versioned Edit did not succeed.')
  }
  return textResponse(`FS_OCC_OK ${FS_OCC_MARKER}`)
}

const UNKNOWN_OUTCOME_MARKER = 'zzqunknownoutcome41x'

function unknownOutcomeRetryResponse(messages) {
  const history = researchToolHistory(messages)
  if (history.results.has('call_unknown_outcome_retry')) return textResponse(`UNKNOWN_OUTCOME_BLOCKED ${UNKNOWN_OUTCOME_MARKER}`)
  return toolCall('Write', { filePath: 'unknown-outcome.txt', content: 'must not be written twice' }, 'call_unknown_outcome_retry')
}

const INVOKE_FALLBACK_MARKER = 'zzqinvokefallback41x'
const TOOL_REPEAT_MARKER = 'zzqtoolrepeat41x'

function toolRepeatReminderResponse(messages) {
  const history = researchToolHistory(messages)
  const calls = [...history.calls.entries()].filter(([id, name]) => name === 'Read' && history.results.has(id))
  if (calls.length < 3) {
    const id = `call_tool_repeat_${calls.length + 1}`
    return toolCall('Read', calls.length % 2 === 0 ? { filePath: 'repeat.txt', offset: 1, limit: 20 } : { limit: 20, filePath: 'repeat.txt', offset: 1 }, id)
  }
  const reminderVisible = messages.some((message) => message?.role === 'user' && String(message.content ?? '').includes('repeating the exact same tool call with identical arguments'))
  return textResponse(`${reminderVisible ? 'TOOL_REPEAT_OK' : 'TOOL_REPEAT_MISSING'} ${TOOL_REPEAT_MARKER}`)
}

function invokeFallbackResponse(messages) {
  const firstTurn = [...messages].reverse().find((message) => message.role === 'user')
  const currentTurnOnly = firstTurn ? messages.slice(messages.indexOf(firstTurn)) : messages
  const hasTodoCard = currentTurnOnly.some((message) => message?.role === 'tool' && String(message.content ?? '').includes('Todo list updated'))
  const readCount = currentTurnOnly.filter((message) => message?.role === 'assistant' && message.tool_calls?.some((call) => call?.function?.name === 'Read')).length
  if (!hasTodoCard) {
    return textResponse(`I will manage the plan first. invoke TodoWrite with todos is [{"content":"invoke fallback durable tool call","status":"completed","priority":"high"}] ${INVOKE_FALLBACK_MARKER}`)
  }
  if (readCount === 0) {
    return textResponse(`invoke Read with filePath is package.json ${INVOKE_FALLBACK_MARKER}`)
  }
  const lastReadResult = [...currentTurnOnly].reverse().find((message) => message?.role === 'tool' && String(message.content ?? '').includes('joker-runtime-contract-fixture'))
  if (!lastReadResult) {
    return textResponse(`INVOKE_FALLBACK_UNEXPECTED: the fallback Read call returned no recognizable file content: ${String(currentTurnOnly.find((message) => message?.role === 'tool')?.content ?? '').slice(0, 120)}`)
  }
  return textResponse(`INVOKE_FALLBACK_OK ${INVOKE_FALLBACK_MARKER}`)
}

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', async () => {
    let parsed = null
    try { parsed = body ? JSON.parse(body) : null } catch { /* handled below */ }
    writeLog({ method: req.method, url: req.url, authorization: req.headers.authorization ?? null, stream: parsed?.stream === true, streamOptions: parsed?.stream_options ?? null, body: parsed })

    if (req.method === 'GET' && req.url === '/v1/models') {
      return json(res, 200, { object: 'list', data: [{ id: 'gpt-4o', object: 'model', owned_by: 'qa' }] })
    }
    if (req.method === 'POST' && req.url === '/v1/images/generations' && scenario === 'image-generation' && parsed) {
      return json(res, 200, {
        created: 0,
        data: [{ b64_json: GENERATED_IMAGE_PNG_BASE64, mime_type: 'image/png' }]
      })
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions' || !parsed || !Array.isArray(parsed.messages)) {
      return json(res, 404, { error: { message: 'not found' } })
    }

    const stream = parsed.stream === true
    const respond = (chunks) => stream ? streamResponse(res, chunks) : json(res, 200, chunks.at(-1)?.choices?.[0]?.delta?.content ? { id: 'chatcmpl-qa', object: 'chat.completion', model: 'gpt-4o', choices: [{ index: 0, message: { role: 'assistant', content: chunks.map((chunk) => chunk.choices?.[0]?.delta?.content ?? '').join('') }, finish_reason: 'stop' }] } : { id: 'chatcmpl-qa', object: 'chat.completion', model: 'gpt-4o', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_read_qa', type: 'function', function: { name: 'Read', arguments: '{"filePath":"package.json"}' } }] }, finish_reason: 'tool_calls' }] })
    const messages = parsed.messages
    const systemText = messages.filter((message) => message.role === 'system').map((message) => String(message.content ?? '')).join('\n')
    if (/Create a durable checkpoint summary of the older conversation history\./i.test(systemText)) return json(res, 200, compactSummaryResponse())
    if (/independent read-only Goal evaluator/i.test(systemText)) return json(res, 200, goalEvaluationResponse(messages))
    if (/<GOAL_OBJECTIVE\b/i.test(systemText)) {
      const round = Number(systemText.match(/<GOAL_OBJECTIVE round="(\d+)">/i)?.[1] ?? 1)
      return respond(textResponse(round >= 2
        ? 'Goal evidence: corrected Slash command flow verified in round 2.'
        : 'Goal evidence: corrected Slash command flow needs a second verification round.'))
    }
    if (/plan-only mode/i.test(systemText)) return respond(planResponse(messages))
    if (scenario === 'toolforge-vertical-slice') return respond(electronToolForgeResponse(messages, parsed.tools, systemText))
    if (scenario === 'fs-optimistic-concurrency') return respond(fsOccResponse(messages))
    if (scenario === 'unknown-outcome-retry') return respond(unknownOutcomeRetryResponse(messages))
    if (scenario === 'invoke-fallback') return respond(invokeFallbackResponse(messages))
    if (scenario === 'tool-repeat-reminder') return respond(toolRepeatReminderResponse(messages))
    if (scenario === 'toolforge-edit-success') return respond(electronToolForgeEditResponse(messages, parsed.tools, systemText, false))
    if (scenario === 'toolforge-edit-failure') return respond(electronToolForgeEditResponse(messages, parsed.tools, systemText, true))
    if (scenario === 'research') return respond(researchResponse(messages))
    if (scenario === 'context-optimization') return respond(contextOptimizationResponse(messages, parsed.tools))
    if (scenario === 'ask-question') return respond(askQuestionResponse(messages))
    if (scenario === 'produced-files') return respond(producedFilesResponse(messages))
    if (scenario === 'queue-steer') {
      const chunks = queueSteerResponse(messages)
      const hasToolResult = messages.some((message) => message?.role === 'tool')
      return stream
        ? delayedStreamResponse(
            res,
            chunks,
            Number(process.env.JOKER_FAKE_STREAM_DELAY_MS || 500),
            hasToolResult ? Number(process.env.JOKER_FAKE_NEXT_STEP_DELAY_MS || 2500) : 0
          )
        : respond(chunks)
    }
    if (scenario === 'multi-session') {
      const chunks = multiSessionResponse(messages)
      const hasToolResult = messages.some((message) => message?.role === 'tool')
      return stream
        ? delayedStreamResponse(
            res,
            chunks,
            Number(process.env.JOKER_FAKE_STREAM_DELAY_MS || 300),
            hasToolResult ? Number(process.env.JOKER_FAKE_NEXT_STEP_DELAY_MS || 1800) : 0
          )
        : respond(chunks)
    }
    if (scenario === 'tool-lifecycle') {
      const chunks = toolLifecycleResponse(messages)
      return stream
        ? delayedStreamResponse(res, chunks, Number(process.env.JOKER_FAKE_STREAM_DELAY_MS || 220))
        : respond(chunks)
    }
    if (scenario === 'subagent-observability') {
      const lastUserIndex = messages.findLastIndex((message) => message.role === 'user')
      const currentTurnMessages = lastUserIndex >= 0 ? messages.slice(lastUserIndex + 1) : messages
      const hasToolResult = currentTurnMessages.some((message) => message.role === 'tool')
      const scenarioRespond = (chunks) => stream
        ? delayedStreamResponse(res, chunks, Number(process.env.JOKER_FAKE_STREAM_DELAY_MS || 450))
        : respond(chunks)
      if (/focused read-only sub-agent/i.test(systemText)) {
        return scenarioRespond(hasToolResult
          ? textResponse('Subagent verified package.json and found the JOKER project configuration.')
          : toolCall('Read', { filePath: 'package.json' }, 'call_subagent_read'))
      }
      return scenarioRespond(hasToolResult
        ? textResponse('The subagent inspection completed and its observable work record is available.')
        : toolCall('Agent', { prompt: 'Inspect package.json and report the project identity.' }, 'call_agent_observability'))
    }

    const lastUserIndex = messages.findLastIndex((message) => message.role === 'user')
    const currentTurnMessages = lastUserIndex >= 0 ? messages.slice(lastUserIndex + 1) : messages
    const hasToolResult = currentTurnMessages.some((message) => message.role === 'tool')
    if (hasToolResult) {
      const lastTool = [...currentTurnMessages].reverse().find((message) => message.role === 'tool')
      const toolText = String(lastTool?.content ?? '')
      if (toolText.includes('denied')) return respond(textResponse('Approval denial was respected; no file was written.'))
      if (toolText.includes('package.json')) return respond(textResponse('Read succeeded. The project package.json contains the JOKER project configuration.'))
      return respond(textResponse('The requested tool call completed successfully.'))
    }

    const lastUser = [...messages].reverse().find((message) => message.role === 'user')
    const prompt = String(lastUser?.content ?? '')
    if (/write|审批|approval|file/i.test(prompt)) {
      return respond(toolCall('Write', { filePath: 'qa-approval-denied.txt', content: 'must not be written' }, 'call_write_qa'))
    }
    if (/read|package\.json|读取/i.test(prompt)) {
      return respond(toolCall('Read', { filePath: 'package.json' }, 'call_read_qa'))
    }
    return respond(textResponse('Fake Provider is online.'))
  })
})

server.listen(port, '127.0.0.1', () => {
  fs.appendFileSync(logPath, JSON.stringify({ ready: true, port }) + '\n')
  console.log(`FAKE_PROVIDER_READY ${port}`)
})

process.on('SIGTERM', () => server.close(() => process.exit(0)))
process.on('SIGINT', () => server.close(() => process.exit(0)))
