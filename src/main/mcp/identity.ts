import { createHash } from 'node:crypto'
import type { McpServerConfig } from '../../shared/types'

export function mcpIdentityFingerprint(config: Pick<McpServerConfig, 'transport' | 'command' | 'args' | 'url'>): string {
  const identity = config.transport === 'stdio'
    ? { transport: 'stdio', command: (config.command ?? '').trim(), args: (config.args ?? []).map((arg) => arg.trim()) }
    : { transport: 'http', url: new URL(config.url ?? '').toString() }
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 32)
}

export function normalizedMcpTrust(config: McpServerConfig): McpServerConfig {
  const fingerprint = mcpIdentityFingerprint(config)
  const trustState = config.trustState === 'trusted' && config.trustedFingerprint === fingerprint
    ? 'trusted'
    : config.trustedFingerprint && config.trustedFingerprint !== fingerprint
      ? 'changed'
      : 'untrusted'
  return {
    ...config,
    trustState,
    trustedFingerprint: trustState === 'trusted' ? fingerprint : config.trustedFingerprint,
    permission: config.permission === 'allow' ? 'allow' : 'deny'
  }
}
