import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import type { McpServerConfig, McpServerRuntime, McpServerStatus, McpRecoveryState } from '../../shared/types'
import { formatSafeError } from '../agent/diagnostics'
import { writeMcpAudit } from './audit'
import { mcpIdentityFingerprint, normalizedMcpTrust } from './identity'

const execFileAsync = promisify(execFile)
const DEFAULT_INITIALIZE_TIMEOUT_MS = 30_000
const DEFAULT_CALL_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_BASE_DELAY_MS = 250
const DEFAULT_MAX_DELAY_MS = 10_000

type Tool = { name: string; description?: string; inputSchema: unknown }
type Transport = StdioClientTransport | StreamableHTTPClientTransport

interface ConnectedServer {
  config: McpServerConfig
  client: Client
  transport: Transport
  tools: Tool[]
  generation: number
  pid?: number
  intentional: boolean
}

interface ServerState {
  config: McpServerConfig
  status: McpServerStatus
  error?: string
  toolCount: number
  fingerprint: string
  recoveryState: McpRecoveryState
  retryCount: number
  pid?: number
  generation: number
}

function abortError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function timeoutError(message: string): Error {
  const error = new Error(message)
  error.name = 'TimeoutError'
  return error
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const candidate = error as Error & { code?: number }
  return error.name === 'TimeoutError' || candidate.code === -32001 || /timed out|timeout/i.test(error.message)
}
async function killProcessTree(pid: number | undefined): Promise<void> {
  if (!pid || pid <= 0) return
  try {
    if (process.platform === 'win32') {
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
      return
    }
    try { process.kill(-pid, 'SIGTERM') } catch { process.kill(pid, 'SIGTERM') }
    await new Promise((resolve) => setTimeout(resolve, 100))
    try { process.kill(-pid, 'SIGKILL') } catch {
      try { process.kill(pid, 'SIGKILL') } catch { /* already exited */ }
    }
  } catch {
    // Cleanup is best effort; lifecycle state and audit still record the attempt.
  }
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal, controller?: AbortController): Promise<T> {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError('The operation was aborted')
  let timer: ReturnType<typeof setTimeout> | undefined
  let abortListener: (() => void) | undefined
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        const error = timeoutError(`MCP operation timed out after ${timeoutMs}ms`)
        controller?.abort(error)
        reject(error)
      }, timeoutMs)
      abortListener = () => {
        const reason = signal?.reason instanceof Error ? signal.reason : abortError('The operation was aborted')
        controller?.abort(reason)
        reject(reason)
      }
      signal?.addEventListener('abort', abortListener, { once: true })
      promise.then(resolve, reject)
    })
  } finally {
    if (timer) clearTimeout(timer)
    if (signal && abortListener) signal.removeEventListener('abort', abortListener)
  }
}

class McpManager {
  private servers = new Map<string, ConnectedServer>()
  private states = new Map<string, ServerState>()
  private generations = new Map<string, number>()
  private operations = new Map<string, Promise<void>>()
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>()

  private nextGeneration(id: string): number {
    const generation = (this.generations.get(id) ?? 0) + 1
    this.generations.set(id, generation)
    return generation
  }

  private currentGeneration(id: string): number {
    return this.generations.get(id) ?? 0
  }

  private setState(config: McpServerConfig, status: McpServerStatus, error?: string, toolCount = 0, recoveryState: McpRecoveryState = 'idle', retryCount = 0, generation = this.currentGeneration(config.id), pid?: number): void {
    this.states.set(config.id, {
      config,
      status,
      error,
      toolCount,
      fingerprint: mcpIdentityFingerprint(config),
      recoveryState,
      retryCount,
      generation,
      pid
    })
  }

  private audit(config: McpServerConfig, generation: number, event: string, details: { status?: string; error?: string; pid?: number; retry?: number } = {}): void {
    writeMcpAudit({
      serverId: config.id,
      serverName: config.name,
      transport: config.transport,
      fingerprint: mcpIdentityFingerprint(config),
      generation,
      event,
      ...details
    })
  }

  private enqueue(id: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.operations.get(id) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    this.operations.set(id, current)
    return current.finally(() => {
      if (this.operations.get(id) === current) this.operations.delete(id)
    })
  }

  seed(config: McpServerConfig): void {
    const normalized = normalizedMcpTrust(config)
    if (!this.states.has(normalized.id)) {
      this.setState(normalized, 'disconnected', undefined, 0, normalized.trustState === 'changed' ? 'idle' : 'idle', 0, this.currentGeneration(normalized.id))
    }
  }

  async connect(config: McpServerConfig): Promise<void> {
    const normalized = normalizedMcpTrust(config)
    this.seed(normalized)
    return this.enqueue(normalized.id, async () => this.connectNow(normalized))
  }

  private async connectNow(config: McpServerConfig): Promise<void> {
    this.clearRetry(config.id)
    const fingerprint = mcpIdentityFingerprint(config)
    if (config.trustState !== 'trusted' || config.trustedFingerprint !== fingerprint) {
      this.setState({ ...config, trustState: config.trustedFingerprint && config.trustedFingerprint !== fingerprint ? 'changed' : 'untrusted' }, 'disconnected', 'MCP server trust is required before connecting')
      this.audit(config, this.currentGeneration(config.id), 'connect-denied', { status: 'untrusted' })
      throw new Error('MCP server trust is required before connecting')
    }
    if (config.permission !== 'allow') {
      this.setState(config, 'disconnected', 'MCP server permission denied')
      this.audit(config, this.currentGeneration(config.id), 'connect-denied', { status: 'permission-denied' })
      throw new Error('MCP server permission denied')
    }
    const generation = this.nextGeneration(config.id)
    await this.closeCurrent(config.id, 'replace')
    this.setState(config, 'connecting', undefined, 0, 'idle', 0, generation)
    this.audit(config, generation, 'connect-start')
    try {
      const connected = await this.connectInternal(config, generation)
      if (this.currentGeneration(config.id) !== generation) {
        await this.closeResources(connected)
        return
      }
      this.servers.set(config.id, connected)
      this.setState(config, 'connected', undefined, connected.tools.length, 'idle', 0, generation, connected.pid)
      this.audit(config, generation, 'connect-success', { pid: connected.pid })
    } catch (error) {
      if (this.currentGeneration(config.id) !== generation) return
      const safe = formatSafeError(error)
      this.setState(config, 'error', safe, 0, 'idle', 0, generation)
      this.audit(config, generation, 'connect-error', { error: safe })
      throw error
    }
  }

  private async connectInternal(config: McpServerConfig, generation: number): Promise<ConnectedServer> {
    const client = new Client({ name: 'joker', version: '0.1.0' })
    let transport: Transport
    if (config.transport === 'stdio') {
      if (!config.command) throw new Error('stdio transport requires a command')
      transport = new StdioClientTransport({ command: config.command, args: config.args ?? [] })
    } else {
      if (!config.url) throw new Error('http transport requires a url')
      transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: config.headers ? { headers: config.headers } : undefined })
    }
    const timeoutMs = config.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS
    try {
      const controller = new AbortController()
      await withDeadline(client.connect(transport, { signal: controller.signal, timeout: timeoutMs, maxTotalTimeout: timeoutMs }), timeoutMs, undefined, controller)
      const { tools } = await withDeadline(client.listTools(undefined, { signal: controller.signal, timeout: timeoutMs, maxTotalTimeout: timeoutMs }), timeoutMs, undefined, controller)
      const connected: ConnectedServer = {
        config,
        client,
        transport,
        tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
        generation,
        pid: transport instanceof StdioClientTransport && typeof transport.pid === 'number' ? transport.pid : undefined,
        intentional: false
      }
      client.onclose = () => { void this.handleUnexpectedClose(config.id, generation, 'client-close') }
      client.onerror = (error) => { void this.handleUnexpectedClose(config.id, generation, formatSafeError(error)) }
      return connected
    } catch (error) {
      await killProcessTree(transport instanceof StdioClientTransport && typeof transport.pid === 'number' ? transport.pid : undefined)
      await transport.close().catch(() => undefined)
      throw error
    }
  }

  private async closeResources(server: ConnectedServer): Promise<void> {
    server.intentional = true
    try { await server.client.close() } catch (error) { this.audit(server.config, server.generation, 'cleanup-error', { error: formatSafeError(error), pid: server.pid }) }
    await killProcessTree(server.pid)
  }

  private async closeCurrent(id: string, reason: string): Promise<void> {
    const server = this.servers.get(id)
    if (!server) return
    this.servers.delete(id)
    await this.closeResources(server)
    this.audit(server.config, server.generation, reason === 'remove' ? 'remove-cleanup' : 'disconnect', { pid: server.pid })
  }

  private async handleUnexpectedClose(id: string, generation: number, reason: string): Promise<void> {
    if (this.currentGeneration(id) !== generation) return
    const server = this.servers.get(id)
    if (!server || server.generation !== generation || server.intentional) return
    this.servers.delete(id)
    const state = this.states.get(id)
    if (!state) return
    const safe = formatSafeError(new Error(reason))
    this.setState(state.config, 'error', safe, 0, 'crashed', state.retryCount, generation)
    this.audit(state.config, generation, 'crash', { error: safe, pid: server.pid })
    await killProcessTree(server.pid)
    this.scheduleRetry(state.config, generation)
  }

  private scheduleRetry(config: McpServerConfig, generation: number): void {
    if (this.currentGeneration(config.id) !== generation || config.enabled === false || config.trustState !== 'trusted' || config.permission !== 'allow') return
    const retryCount = (this.states.get(config.id)?.retryCount ?? 0) + 1
    const recovery = config.recovery
    const maxRetries = recovery?.maxRetries ?? DEFAULT_MAX_RETRIES
    if (retryCount > maxRetries) {
      this.setState(config, 'error', 'MCP recovery retry limit reached', 0, 'cutoff', retryCount, generation)
      this.audit(config, generation, 'recovery-cutoff', { retry: retryCount })
      return
    }
    const base = recovery?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
    const max = recovery?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
    const delay = Math.min(max, base * 2 ** (retryCount - 1))
    this.setState(config, 'connecting', undefined, 0, 'recovering', retryCount, generation)
    this.audit(config, generation, 'recovery-retry', { retry: retryCount })
    const timer = setTimeout(() => {
      this.retryTimers.delete(config.id)
      void this.enqueue(config.id, async () => {
        if (this.currentGeneration(config.id) !== generation) return
        try { await this.connectNow(config) } catch { /* state and audit already record failure */ }
      })
    }, delay)
    this.retryTimers.set(config.id, timer)
  }

  private clearRetry(id: string): void {
    const timer = this.retryTimers.get(id)
    if (timer) clearTimeout(timer)
    this.retryTimers.delete(id)
  }

  async disconnect(id: string): Promise<void> {
    return this.enqueue(id, async () => {
      this.clearRetry(id)
      this.nextGeneration(id)
      const state = this.states.get(id)
      const server = this.servers.get(id)
      this.servers.delete(id)
      if (server) await this.closeResources(server)
      if (state) this.setState(state.config, 'disconnected', undefined, 0, 'idle', 0, this.currentGeneration(id))
    })
  }

  async disconnectAll(): Promise<void> {
    const ids = new Set([...this.states.keys(), ...this.servers.keys()])
    await Promise.all([...ids].map((id) => this.disconnect(id)))
  }

  listServers(): McpServerConfig[] {
    return [...this.states.values()].map((state) => state.config)
  }

  listRuntime(): McpServerRuntime[] {
    return [...this.states.values()].map((state) => ({
      id: state.config.id,
      name: state.config.name,
      enabled: state.config.enabled,
      transport: state.config.transport,
      connected: state.status === 'connected',
      status: state.status,
      error: state.error,
      toolCount: state.toolCount,
      trustState: state.config.trustState ?? 'untrusted',
      trustedFingerprint: state.config.trustedFingerprint,
      fingerprint: state.fingerprint,
      permission: state.config.permission ?? 'deny',
      recoveryState: state.recoveryState,
      retryCount: state.retryCount,
      pid: state.pid
    }))
  }

  async refresh(id: string): Promise<void> {
    const state = this.states.get(id)
    if (!state) throw new Error(`MCP server not found: ${id}`)
    await this.connect(state.config)
  }

  async trust(id: string): Promise<McpServerConfig> {
    const state = this.states.get(id)
    if (!state) throw new Error(`MCP server not found: ${id}`)
    const config = normalizedMcpTrust({ ...state.config, trustState: 'trusted', trustedFingerprint: mcpIdentityFingerprint(state.config) })
    this.setState(config, 'disconnected', undefined, 0, 'idle', 0, this.currentGeneration(id))
    this.audit(config, this.currentGeneration(id), 'trust-grant')
    return config
  }

  async revokeTrust(id: string): Promise<McpServerConfig> {
    const state = this.states.get(id)
    if (!state) throw new Error(`MCP server not found: ${id}`)
    await this.disconnect(id)
    const config = { ...state.config, trustState: 'untrusted' as const, trustedFingerprint: undefined }
    this.setState(config, 'disconnected', undefined, 0, 'idle', 0, this.currentGeneration(id))
    this.audit(config, this.currentGeneration(id), 'trust-revoke')
    return config
  }

  async setPermission(id: string, permission: 'allow' | 'deny'): Promise<McpServerConfig> {
    const state = this.states.get(id)
    if (!state) throw new Error(`MCP server not found: ${id}`)
    if (permission === 'deny') await this.disconnect(id)
    const current = this.states.get(id) ?? state
    const config = { ...current.config, permission }
    this.setState(config, permission === 'deny' ? 'disconnected' : current.status, current.error, permission === 'deny' ? 0 : current.toolCount, permission === 'deny' ? 'idle' : current.recoveryState, permission === 'deny' ? 0 : current.retryCount, this.currentGeneration(id), permission === 'deny' ? undefined : current.pid)
    this.audit(config, this.currentGeneration(id), 'permission-change', { status: permission })
    return config
  }

  async remove(id: string): Promise<void> {
    return this.enqueue(id, async () => {
      this.clearRetry(id)
      this.nextGeneration(id)
      const server = this.servers.get(id)
      this.servers.delete(id)
      if (server) await this.closeResources(server)
      this.states.delete(id)
      this.audit(server?.config ?? { id, name: id, transport: 'stdio', enabled: false }, this.currentGeneration(id), 'remove', { pid: server?.pid })
    })
  }

  getAllTools(): Array<{ serverId: string; serverName: string; tool: Tool }> {
    const result: Array<{ serverId: string; serverName: string; tool: Tool }> = []
    for (const [id, server] of this.servers) {
      if (server.config.trustState !== 'trusted' || server.config.permission !== 'allow') continue
      for (const tool of server.tools) result.push({ serverId: id, serverName: server.config.name, tool })
    }
    return result
  }

  async callTool(serverId: string, toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError('The operation was aborted')
    const server = this.servers.get(serverId)
    const state = this.states.get(serverId)
    if (!server || !state) throw new Error(`MCP server not connected: ${serverId}`)
    if (server.config.trustState !== 'trusted') throw new Error('MCP server is not trusted')
    if (server.config.permission !== 'allow') throw new Error('MCP server permission denied')
    if (!server.tools.some((tool) => tool.name === toolName)) throw new Error(`MCP tool not found: ${toolName}`)
    const generation = server.generation
    const timeoutMs = server.config.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const result = await withDeadline(server.client.callTool({ name: toolName, arguments: args }, undefined, { signal: controller.signal, timeout: timeoutMs, maxTotalTimeout: timeoutMs }), timeoutMs, signal, controller)
      if (this.currentGeneration(serverId) !== generation || this.servers.get(serverId) !== server) throw new Error('MCP connection was replaced')
      return result
    } catch (error) {
      if (isTimeoutError(error)) {
        this.audit(server.config, generation, 'call-timeout', { error: error instanceof Error ? error.message : String(error), pid: server.pid })
        await this.handleUnexpectedClose(serverId, generation, 'tool-call-timeout')
      }
      throw error
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  isConnected(id: string): boolean { return this.servers.has(id) }

  getRuntime(id: string): McpServerRuntime | undefined { return this.listRuntime().find((server) => server.id === id) }
}

export const mcpManager = new McpManager()
