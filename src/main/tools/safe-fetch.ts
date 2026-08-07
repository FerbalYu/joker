import { lookup as dnsLookup } from 'node:dns'
import type { LookupFunction } from 'node:net'
import { Agent, buildConnector, type Dispatcher } from 'undici'

import { isPrivateAddress, validatePublicUrl } from './url-policy'

export interface SafeFetchOptions {
  maxRedirects?: number
  allowedOrigins?: ReadonlySet<string>
}

interface ResolvedAddress {
  address: string
  family: 4 | 6
}

export interface SafeFetchDependencies {
  lookup?: LookupFunction
  connect?: ReturnType<typeof buildConnector>
  fetch?: typeof globalThis.fetch
  onConnectAttempt?: (address: string) => void
}

const DEFAULT_MAX_REDIRECTS = 4

function blockedAddressError(hostname: string): Error {
  return new Error(`The URL resolves to a local, private, or non-public network address: ${hostname}`)
}

function normalizeFamily(value: number | string): 4 | 6 {
  return value === 6 || value === 'IPv6' ? 6 : 4
}

async function resolveAll(hostname: string, lookup: LookupFunction): Promise<ResolvedAddress[]> {
  if (isPrivateAddress(hostname)) throw blockedAddressError(hostname)
  return new Promise((resolvePromise, reject) => {
    lookup(hostname, { all: true, verbatim: true }, (error, records) => {
      if (error) {
        reject(error)
        return
      }
      if (!Array.isArray(records)) {
        reject(new Error(`DNS lookup did not return all addresses for ${hostname}`))
        return
      }
      const normalized = records.map((record) => ({ address: record.address, family: normalizeFamily(record.family) }))
      if (normalized.length === 0 || normalized.some((record) => isPrivateAddress(record.address))) {
        reject(blockedAddressError(hostname))
        return
      }
      resolvePromise(normalized)
    })
  })
}

export async function createSafeDispatcher(url: string | URL, dependencies: SafeFetchDependencies = {}): Promise<Dispatcher> {
  const target = validatePublicUrl(url.toString())
  const lookup = dependencies.lookup ?? dnsLookup as LookupFunction
  const records = await resolveAll(target.hostname, lookup)
  const approved = new Map(records.map((record) => [record.address, record.family]))
  let next = 0
  const baseConnect = dependencies.connect ?? buildConnector({})
  const dispatcher = new Agent({
    connect(options, callback) {
      const hostname = options.hostname.replace(/^\[|\]$/g, '')
      const approvedRecord = approved.has(hostname)
        ? { address: hostname, family: approved.get(hostname)! }
        : records[next++ % records.length]
      if (!approvedRecord || isPrivateAddress(approvedRecord.address)) {
        callback(blockedAddressError(hostname), null)
        return
      }
      dependencies.onConnectAttempt?.(approvedRecord.address)
      baseConnect({
        ...options,
        hostname: approvedRecord.address,
        host: approvedRecord.address,
        servername: options.servername ?? target.hostname
      }, callback)
    }
  })
  return dispatcher
}

function redirectMethod(status: number, method: string): { method: string; dropBody: boolean } {
  const normalized = method.toUpperCase()
  if (status === 303 || ((status === 301 || status === 302) && normalized === 'POST')) {
    return { method: 'GET', dropBody: true }
  }
  return { method, dropBody: false }
}

function responseLocation(response: Response): string | null {
  return response.status >= 300 && response.status < 400 ? response.headers.get('location') : null
}

function responseWithDispatcherCleanup(response: Response, dispatcher: Dispatcher): Response {
  if (!response.body) {
    void dispatcher.close().catch(() => undefined)
    return response
  }
  const reader = response.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          controller.close()
          await dispatcher.close().catch(() => undefined)
        } else {
          controller.enqueue(next.value)
        }
      } catch (error) {
        controller.error(error)
        await dispatcher.close().catch(() => undefined)
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined)
      await dispatcher.close().catch(() => undefined)
    }
  })
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  })
}

export async function safeFetch(input: string | URL, init: RequestInit = {}, options: SafeFetchOptions = {}, dependencies: SafeFetchDependencies = {}): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  let current = validatePublicUrl(input.toString())
  let method = init.method ?? 'GET'
  let body = init.body

  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    if (options.allowedOrigins && !options.allowedOrigins.has(current.origin)) {
      throw new Error(`URL origin is not allowed: ${current.origin}`)
    }
    const dispatcher = await createSafeDispatcher(current, dependencies)
    let returned = false
    try {
      const response = await (dependencies.fetch ?? globalThis.fetch)(current, {
        ...init,
        method,
        body,
        redirect: 'manual',
        ...({ dispatcher } as unknown as RequestInit)
      })
      const location = responseLocation(response as unknown as Response)
      if (!location || maxRedirects === 0) {
        returned = true
        return responseWithDispatcherCleanup(response as unknown as Response, dispatcher)
      }
      if (redirect === maxRedirects) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error('Too many redirects')
      }
      const next = validatePublicUrl(new URL(location, current).toString())
      const transformed = redirectMethod(response.status, method)
      method = transformed.method
      if (transformed.dropBody) body = null
      await response.body?.cancel().catch(() => undefined)
      current = next
    } finally {
      if (!returned) await dispatcher.close().catch(() => undefined)
    }
  }
  throw new Error('Too many redirects')
}

export const SAFE_FETCH_MAX_REDIRECTS = DEFAULT_MAX_REDIRECTS
