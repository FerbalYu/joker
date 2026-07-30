import http from 'node:http'
import fs from 'node:fs'

const port = Number(process.env.PORT || 18765)
const logPath = process.env.LOG_PATH || '.qa/fake-provider.log'
const scenario = process.env.JOKER_FAKE_SCENARIO || 'default'
const requests = []

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
    { id: 'chatcmpl-qa', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'gpt-4o', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
  ]
}

function textResponse(text) {
  return [
    { id: 'chatcmpl-qa', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'gpt-4o', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
    { id: 'chatcmpl-qa', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'gpt-4o', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
  ]
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function delayedStreamResponse(res, chunks, delayMs) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
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
        title: 'Deterministic verification counts',
        xLabel: 'Artifact',
        yLabel: 'Count',
        sourceIds: ['S1'],
        data: [
          { label: 'Verified source', value: 1 },
          { label: 'Report sections', value: 2 }
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

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', async () => {
    let parsed = null
    try { parsed = body ? JSON.parse(body) : null } catch { /* handled below */ }
    writeLog({ method: req.method, url: req.url, authorization: req.headers.authorization ?? null, body: parsed })

    if (req.method === 'GET' && req.url === '/v1/models') {
      return json(res, 200, { object: 'list', data: [{ id: 'gpt-4o', object: 'model', owned_by: 'qa' }] })
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions' || !parsed || !Array.isArray(parsed.messages)) {
      return json(res, 404, { error: { message: 'not found' } })
    }

    const stream = parsed.stream === true
    const respond = (chunks) => stream ? streamResponse(res, chunks) : json(res, 200, chunks.at(-1)?.choices?.[0]?.delta?.content ? { id: 'chatcmpl-qa', object: 'chat.completion', model: 'gpt-4o', choices: [{ index: 0, message: { role: 'assistant', content: chunks.map((chunk) => chunk.choices?.[0]?.delta?.content ?? '').join('') }, finish_reason: 'stop' }] } : { id: 'chatcmpl-qa', object: 'chat.completion', model: 'gpt-4o', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_read_qa', type: 'function', function: { name: 'Read', arguments: '{\"filePath\":\"package.json\"}' } }] }, finish_reason: 'tool_calls' }] })
    const messages = parsed.messages
    if (scenario === 'research') return respond(researchResponse(messages))
    if (scenario === 'context-optimization') return respond(contextOptimizationResponse(messages, parsed.tools))
    if (scenario === 'tool-lifecycle') {
      const chunks = toolLifecycleResponse(messages)
      return stream
        ? delayedStreamResponse(res, chunks, Number(process.env.JOKER_FAKE_STREAM_DELAY_MS || 220))
        : respond(chunks)
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
