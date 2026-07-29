import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server, type RequestListener } from 'node:http'
import { once } from 'node:events'
import { readWebPage, type WebReadDependencies } from './web'
import { findBrowserExecutable, readRenderedPage } from './web-browser'

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

async function startServer(handler: RequestListener): Promise<{ server: Server; url: string }> {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, url: `http://127.0.0.1:${address.port}` }
}

function localDependencies(browserText = 'browser rendered text'): WebReadDependencies {
  return {
    assertPublicUrl: async (value) => new URL(value),
    readRenderedPage: async (url) => ({ finalUrl: url, title: 'Rendered', text: browserText, status: 200, contentType: 'text/html' })
  }
}

void test('WebRead real browser fallback renders dynamic loopback content with request guard', async (t) => {
  const executable = findBrowserExecutable()
  if (!executable) {
    t.skip('No supported Chrome or Edge executable is installed')
    return
  }
  const { server, url } = await startServer((request, response) => {
    if (request.url === '/private-target') {
      response.writeHead(200, { 'Content-Type': 'text/html' }).end('<p>unexpected private target</p>')
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html' }).end('<html><head><title>Real dynamic fixture</title></head><body><div id="root">loading</div><script>setTimeout(() => { document.querySelector("#root").textContent = "real browser dynamic content" }, 50)</script></body></html>')
  })
  try {
    const result = await readRenderedPage(`${url}/dynamic`, { timeoutMs: 10_000, maxChars: 20_000 }, undefined, {
      assertPublicUrl: async (value) => new URL(value)
    })
    assert.match(result.text, /real browser dynamic content/)
    assert.equal(result.title, 'Real dynamic fixture')
    assert.equal(result.status, 200)
  } finally {
    await closeServer(server)
  }
})
void test('WebRead contract reads static HTML and follows public redirects', async () => {
  const { server, url } = await startServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/article' }).end()
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<html><head><title>Fixture</title></head><body><h1>Static article</h1><p>Readable content.</p></body></html>')
  })
  try {
    const result = await readWebPage(`${url}/redirect`, {}, undefined, localDependencies())
    assert.equal(result.metadata?.source, 'http')
    assert.equal(result.metadata?.status, 200)
    assert.match(result.output, /Static article/)
    assert.match(result.output, /Title: Fixture/)
  } finally {
    await closeServer(server)
  }
})

void test('WebRead contract rejects unsupported content and falls back for a JavaScript shell', async () => {
  const { server, url } = await startServer((request, response) => {
    if (request.url === '/json') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"secret":true}')
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html' }).end('<html><head><title>Shell</title></head><body><div id="root"></div><script>document.querySelector("#root").textContent = "dynamic"</script></body></html>')
  })
  try {
    const unsupported = await readWebPage(`${url}/json`, {}, undefined, localDependencies())
    assert.equal(unsupported.metadata?.source, 'browser')
    assert.match(unsupported.output, /browser rendered text/)

    const dynamic = await readWebPage(`${url}/shell`, {}, undefined, localDependencies('dynamic rendered text'))
    assert.equal(dynamic.metadata?.source, 'browser')
    assert.match(dynamic.output, /dynamic rendered text/)
  } finally {
    await closeServer(server)
  }
})

void test('WebRead contract truncates oversized responses and reports timeout/abort', async () => {
  const { server, url } = await startServer((request, response) => {
    if (request.url === '/slow') {
      setTimeout(() => response.writeHead(200, { 'Content-Type': 'text/plain' }).end('late'), 250)
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/plain' }).end('x'.repeat(2_100_000))
  })
  try {
    const oversized = await readWebPage(`${url}/large`, { maxChars: 1_000 }, undefined, localDependencies())
    assert.equal(oversized.metadata?.source, 'http')
    assert.equal(oversized.metadata?.truncated, true)
    assert.match(oversized.output, /content was truncated/)

    const controller = new AbortController()
    controller.abort(new Error('cancelled by contract'))
    await assert.rejects(readWebPage(`${url}/slow`, {}, controller.signal, localDependencies()), /cancelled by contract/)
  } finally {
    await closeServer(server)
  }
})
