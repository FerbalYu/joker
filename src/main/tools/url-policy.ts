import { promises as dns } from 'node:dns'
import { isIP } from 'node:net'

const METADATA_HOSTNAMES = new Set([
  'metadata',
  'metadata.google.internal',
  'instance-data.ec2.internal'
])

export function validatePublicUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Invalid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http:// and https:// URLs are allowed')
  }
  if (url.username || url.password) {
    throw new Error('URLs with embedded credentials are not allowed')
  }
  if (!url.hostname) throw new Error('URL hostname is required')
  return url
}

function parseMappedIpv4(address: string): string | null {
  const value = address.toLowerCase().replace(/^\[|\]$/g, '').split('%', 1)[0] ?? address
  const dotted = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (dotted) return dotted[1]
  const hex = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (!hex) return null
  const first = Number.parseInt(hex[1], 16)
  const second = Number.parseInt(hex[2], 16)
  return `${first >>> 8}.${first & 0xff}.${second >>> 8}.${second & 0xff}`
}

export function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '').split('%', 1)[0] ?? address
  const hostname = normalized.replace(/\.$/, '')
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || METADATA_HOSTNAMES.has(hostname)) return true

  const mappedIpv4 = parseMappedIpv4(hostname)
  if (mappedIpv4) return isPrivateAddress(mappedIpv4)

  if (isIP(hostname) === 4) {
    const octets = hostname.split('.').map(Number)
    const [a, b] = octets
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
  }

  if (isIP(hostname) === 6) {
    const firstHextet = Number.parseInt(hostname.split(':')[0] || '0', 16)
    return hostname === '::' || hostname === '::1' ||
      (firstHextet & 0xfe00) === 0xfc00 || // IPv6 ULA: fc00::/7
      (firstHextet & 0xffc0) === 0xfe80 || // IPv6 link-local: fe80::/10
      (firstHextet & 0xff00) === 0xff00 || // multicast is not a public unicast target
      hostname.startsWith('2001:db8:') || // documentation range
      hostname.startsWith('2001:0000:')
  }
  return false
}

export async function assertPublicUrl(value: string | URL): Promise<URL> {
  const url = typeof value === 'string' ? validatePublicUrl(value) : validatePublicUrl(value.toString())
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  if (isPrivateAddress(hostname)) throw new Error('Local and private network URLs are not allowed')

  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error('Local and private network URLs are not allowed')
    return url
  }

  const records = await dns.lookup(hostname, { all: true, verbatim: true })
  if (records.length === 0 || records.some((record) => isPrivateAddress(record.address))) {
    throw new Error('The URL resolves to a local or private network address')
  }
  return url
}

export const validateWebUrl = validatePublicUrl
export const assertPublicWebUrl = assertPublicUrl
