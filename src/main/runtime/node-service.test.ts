import test from 'node:test'
import assert from 'node:assert/strict'
import { NodeService } from './node-service'
import { CordisRuntime, createNodeServicePlugin } from './cordis'

async function getJson(url: string): Promise<{ status: number; body: { ok?: boolean; services?: unknown[] } }> {
  const response = await fetch(url)
  return { status: response.status, body: await response.json() as { ok?: boolean; services?: unknown[] } }
}

void test('Cordis runtime starts and disposes the Node service plugin', async () => {
  const service = new NodeService({ port: 0 })
  const runtime = new CordisRuntime()
  await runtime.use(createNodeServicePlugin(service))
  await runtime.start()
  const address = await service.start()
  const health = await getJson(`${address.url}/health`)
  assert.equal(health.status, 200)
  assert.equal(health.body.ok, true)
  await runtime.stop()
  await assert.rejects(fetch(`${address.url}/health`))
})

void test('Node service exposes service inventory and rejects unsupported routes', async () => {
  const service = new NodeService({ port: 0 })
  const address = await service.start()
  try {
    const services = await getJson(`${address.url}/services`)
    assert.equal(services.status, 200)
    assert.equal(services.body.services?.length, 1)
    const missing = await fetch(`${address.url}/missing`)
    assert.equal(missing.status, 404)
  } finally {
    await service.stop()
  }
})
