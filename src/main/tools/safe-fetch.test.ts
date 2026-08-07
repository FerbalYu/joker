import test from 'node:test'
import assert from 'node:assert/strict'
import type { LookupFunction } from 'node:net'
import type { buildConnector } from 'undici'

import { createSafeDispatcher, safeFetch } from './safe-fetch'

function lookupWith(addresses: Array<{ address: string; family: 4 | 6 }>): LookupFunction {
  return ((_hostname: string, _options: unknown, callback: (error: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: 4 | 6 }>) => void) => {
    callback(null, addresses)
  }) as LookupFunction
}

void test('safe dispatcher rejects rebinding to a private address before any connection', async () => {
  let connections = 0
  const connect = ((_options, callback) => {
    connections += 1
    callback(new Error('unexpected connection'), null)
  }) as ReturnType<typeof buildConnector>

  await assert.rejects(
    createSafeDispatcher('https://rebind.example.test/resource', {
      lookup: lookupWith([{ address: '127.0.0.1', family: 4 }]),
      connect
    }),
    /local, private, or non-public/
  )
  assert.equal(connections, 0)
})

void test('safe dispatcher rejects mixed public and private DNS results with zero connections', async () => {
  let connections = 0
  const connect = ((_options, callback) => {
    connections += 1
    callback(new Error('unexpected connection'), null)
  }) as ReturnType<typeof buildConnector>

  await assert.rejects(
    createSafeDispatcher('https://mixed.example.test/resource', {
      lookup: lookupWith([
        { address: '93.184.216.34', family: 4 },
        { address: '::ffff:127.0.0.1', family: 6 }
      ]),
      connect
    }),
    /local, private, or non-public/
  )
  assert.equal(connections, 0)
})

void test('safe fetch guards every redirect target before requesting it', async () => {
  const requested: string[] = []
  const lookups: string[] = []
  const fetchStub = (async (input: string | URL) => {
    const url = String(input)
    requested.push(url)
    if (url === 'https://public.example.test/start') {
      return new Response(null, { status: 302, headers: { location: 'https://private.example.test/secret' } }) as never
    }
    throw new Error('unexpected second request')
  }) as never

  await assert.rejects(
    safeFetch('https://public.example.test/start', {}, {}, {
      lookup: ((_hostname: string, _options: unknown, callback: (error: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: 4 | 6 }>) => void) => {
        lookups.push(_hostname)
        callback(null, [{ address: _hostname === 'private.example.test' ? '10.0.0.8' : '93.184.216.34', family: 4 }])
      }) as LookupFunction,
      fetch: fetchStub
    }),
    /local, private, or non-public/
  )
  assert.deepEqual(requested, ['https://public.example.test/start'])
  assert.deepEqual(lookups, ['public.example.test', 'private.example.test'])
})

void test('safe dispatcher preserves target hostname for TLS SNI while connecting to approved IP', async () => {
  let seen: Record<string, unknown> | undefined
  const connect = ((options, callback) => {
    seen = options as unknown as Record<string, unknown>
    callback(new Error('stop after inspection'), null)
  }) as ReturnType<typeof buildConnector>
  const dispatcher = await createSafeDispatcher('https://public.example.test/resource', {
    lookup: lookupWith([{ address: '93.184.216.34', family: 4 }]),
    connect
  })
  try {
    await assert.rejects(dispatcher.request({ origin: 'https://public.example.test', path: '/resource', method: 'GET' }), /stop after inspection/)
    assert.equal(seen?.hostname, '93.184.216.34')
    assert.equal(seen?.host, '93.184.216.34')
    assert.equal(seen?.servername, 'public.example.test')
  } finally {
    await dispatcher.close()
  }
})
