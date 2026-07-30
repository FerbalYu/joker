import http from 'node:http'

const port = Number(process.env.PORT || 18865)
const chunkCount = Math.max(1, Number(process.env.STREAM_CHUNKS || 1000))
const chunkDelayMs = Math.max(0, Number(process.env.STREAM_CHUNK_DELAY_MS || 0))
const abortChunkDelayMs = Math.max(0, Number(process.env.STREAM_ABORT_CHUNK_DELAY_MS || chunkDelayMs))
const requests = []
let completedRequests = 0
let abortedRequests = 0

function writeJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

function recordRequest(request, body) {
  requests.push({
    method: request.method,
    url: request.url,
    hasAuthorization: Boolean(request.headers.authorization),
    messageCount: Array.isArray(body?.messages) ? body.messages.length : 0,
    stream: body?.stream === true,
    abortTest: typeof body?.messages?.at(-1)?.content === 'string' && body.messages.at(-1).content.includes('STREAM_ABORT_TEST'),
    chunkCount
  })
}

function streamCompletion(response) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive'
  })
  const requestedDelay = requests.at(-1)?.abortTest ? abortChunkDelayMs : chunkDelayMs
  let index = 0
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    abortedRequests += index < chunkCount ? 1 : 0
    clearTimeout(timer)
  }
  response.on('close', close)
  const send = () => {
    if (closed) return
    if (index >= chunkCount) {
      response.end('data: [DONE]\n\n')
      completedRequests += 1
      closed = true
      return
    }
    const chunk = {
      id: 'chatcmpl-stream-qa',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'stream-qa',
      choices: [{ index: 0, delta: { content: `stream-token-${index};` }, finish_reason: null }]
    }
    response.write(`data: ${JSON.stringify(chunk)}\n\n`)
    index += 1
    if (requestedDelay > 0) timer = setTimeout(send, requestedDelay)
    else setImmediate(send)
  }
  let timer
  send()
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/stats') {
    writeJson(response, 200, { requests, completedRequests, abortedRequests })
    return
  }
  if (request.method !== 'GET' && request.method !== 'POST') {
    writeJson(response, 405, { error: 'method not allowed' })
    return
  }
  let body = ''
  request.setEncoding('utf8')
  request.on('data', (chunk) => { body += chunk })
  request.on('end', () => {
    let parsed = null
    try { parsed = body ? JSON.parse(body) : null } catch { /* handled as invalid request */ }
    recordRequest(request, parsed)
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions' || !parsed || !Array.isArray(parsed.messages)) {
      writeJson(response, 404, { error: { message: 'not found' } })
      return
    }
    if (parsed.stream !== true) {
      writeJson(response, 200, {
        id: 'chatcmpl-stream-qa',
        object: 'chat.completion',
        model: 'stream-qa',
        choices: [{ index: 0, message: { role: 'assistant', content: 'stream fixture' }, finish_reason: 'stop' }]
      })
      return
    }
    streamCompletion(response)
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`STREAM_PROVIDER_READY ${port}`)
})

function shutdown() {
  server.close(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
