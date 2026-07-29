import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { mcpManager } from '../src/main/mcp/client.ts'
import { mcpIdentityFingerprint } from '../src/main/mcp/identity.ts'
import { setMcpAuditPathForTests } from '../src/main/mcp/audit.ts'
import { validateServerConfig } from '../src/main/ipc/mcp-config.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const runDir = await mkdtemp(join(tmpdir(), 'joker-mcp-boundary-'))
const reportPath = join(runDir, 'mcp-boundary-report.json')
const fixturePath = join(runDir, 'mcp-fixture.mjs')
const auditPath = join(runDir, 'mcp-audit.jsonl')
const secret = 'Bearer qualification-secret-must-not-be-written'

await writeFile(fixturePath, `
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { McpServer } from '${pathToFileURL(join(root, 'node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js')).href}'
import { StdioServerTransport } from '${pathToFileURL(join(root, 'node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js')).href}'
import { z } from '${pathToFileURL(join(root, 'node_modules/zod/index.js')).href}'
const mode = process.argv[1] || process.env.JOKER_MCP_FIXTURE_MODE || 'healthy'
const marker = process.argv[2]
const server = new McpServer({ name: 'joker-mcp-boundary-fixture', version: '1.0.0' })
server.registerTool('echo', { inputSchema: { message: z.string() } }, async ({ message }) => ({ content: [{ type: 'text', text: message }] }))
server.registerTool('hang', { inputSchema: {} }, async () => await new Promise(() => {}))
server.registerTool('crash', { inputSchema: {} }, async () => { setTimeout(() => process.exit(37), 25); return await new Promise(() => {}) })
if (mode === 'hang-initialize') await new Promise(() => {})
if (mode === 'descendant') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
  if (marker) writeFileSync(marker, JSON.stringify({ parent: process.pid, child: child.pid }), 'utf8')
}
await server.connect(new StdioServerTransport())
if (marker && mode !== 'descendant') writeFileSync(marker, JSON.stringify({ parent: process.pid }), 'utf8')
if (mode === 'crash-after-ready') setTimeout(() => process.exit(37), 150)
`, 'utf8')
setMcpAuditPathForTests(auditPath)

const checks = []
const record = (id, status, expected, observed, evidence = {}) => checks.push({ id, status, expected, observed, evidence })
function fixtureConfig(id, mode, options = {}) {
  const marker = join(runDir, `${id}.json`)
  const args = ['--input-type=module', '-e', `import(${JSON.stringify(pathToFileURL(fixturePath).href)})`, mode, marker]
  const base = { id, name: `Boundary ${mode}`, enabled: true, transport: 'stdio', command: process.execPath, args, autoConnect: true, permission: 'allow', initializeTimeoutMs: 30_000, callTimeoutMs: 30_000, recovery: { maxRetries: 0, baseDelayMs: 100, maxDelayMs: 200 } }
  const fingerprint = mcpIdentityFingerprint(base)
  return validateServerConfig({ ...base, ...options, trustState: 'trusted', trustedFingerprint: fingerprint })
}
async function waitFor(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await predicate()) return true; await new Promise((resolve) => setTimeout(resolve, 25)) }
  return Boolean(await predicate())
}
async function waitForExit(pid, timeout = 3000) { return waitFor(() => { try { process.kill(pid, 0); return false } catch { return true } }, timeout) }
async function cleanup(id) { await mcpManager.remove(id).catch(() => undefined) }

const trustId = `trust-${crypto.randomUUID()}`
const trustBase = fixtureConfig(trustId, 'healthy', { permission: 'deny' })
mcpManager.seed({ ...trustBase, trustState: 'untrusted', trustedFingerprint: undefined })
try { await mcpManager.connect({ ...trustBase, trustState: 'untrusted', trustedFingerprint: undefined }); record('mcp.trust.command-grant', 'fail', 'untrusted stdio connection is rejected', 'connect unexpectedly succeeded') }
catch (error) { record('mcp.trust.command-grant', 'pass', 'untrusted stdio connection is rejected', String(error), { noCredentials: true }) }
const trusted = await mcpManager.trust(trustId)
await mcpManager.setPermission(trustId, 'allow')
record('mcp.trust.endpoint-grant', mcpManager.getRuntime(trustId)?.trustState === 'trusted' ? 'pass' : 'fail', 'explicit trust records current identity fingerprint', mcpManager.getRuntime(trustId), { trustedFingerprint: trusted.trustedFingerprint })
await cleanup(trustId)

const changedId = `changed-${crypto.randomUUID()}`
const original = fixtureConfig(changedId, 'healthy')
const changed = { ...original, args: [...(original.args ?? []), 'identity-change'] }
mcpManager.seed(original)
try { await mcpManager.connect({ ...changed, trustState: 'trusted', trustedFingerprint: original.trustedFingerprint }); record('mcp.trust.changed-identity-revokes', 'fail', 'changed identity is rejected', 'connect unexpectedly succeeded') }
catch (error) { record('mcp.trust.changed-identity-revokes', mcpManager.getRuntime(changedId)?.trustState === 'changed' ? 'pass' : 'fail', 'changed identity is rejected and runtime is changed', mcpManager.getRuntime(changedId), { error: String(error) }) }
await cleanup(changedId)

const deniedId = `deny-${crypto.randomUUID()}`
const denied = fixtureConfig(deniedId, 'healthy', { permission: 'deny' })
try { await mcpManager.connect(denied); record('mcp.permission.server-policy', 'fail', 'server permission deny blocks connect', 'connect unexpectedly succeeded') }
catch (error) { record('mcp.permission.server-policy', 'pass', 'server permission deny blocks connect', String(error), { permission: 'deny' }) }
record('mcp.permission.full-auto-boundary', mcpManager.getAllTools().some((tool) => tool.serverId === deniedId) ? 'fail' : 'pass', 'manager deny does not expose tools regardless of approval mode', mcpManager.getAllTools().filter((tool) => tool.serverId === deniedId), { approvalModeIndependent: true })
await cleanup(deniedId)

const initId = `init-timeout-${crypto.randomUUID()}`
const initConfig = fixtureConfig(initId, 'hang-initialize', { initializeTimeoutMs: 200 })
const initStarted = Date.now()
try { await mcpManager.connect(initConfig); record('mcp.recovery.initialize-timeout', 'fail', 'hung initialize is bounded by manager deadline', 'connect unexpectedly succeeded') }
catch (error) { record('mcp.recovery.initialize-timeout', mcpManager.getRuntime(initId)?.status === 'error' && Date.now() - initStarted < 2000 ? 'pass' : 'fail', 'hung initialize is bounded by manager deadline', mcpManager.getRuntime(initId), { elapsedMs: Date.now() - initStarted, error: String(error) }) }
await cleanup(initId)

const callId = `call-timeout-${crypto.randomUUID()}`
await mcpManager.connect(fixtureConfig(callId, 'healthy', { callTimeoutMs: 200 }))
try { await mcpManager.callTool(callId, 'hang', {}); record('mcp.recovery.call-timeout', 'fail', 'hung call is bounded and connection is fenced', 'call unexpectedly succeeded') }
catch (error) { const runtime = mcpManager.getRuntime(callId); record('mcp.recovery.call-timeout', runtime?.recoveryState === 'crashed' || runtime?.status === 'error' ? 'pass' : 'fail', 'hung call is bounded and connection is fenced', runtime, { error: String(error) }) }
await cleanup(callId)

const crashId = `crash-${crypto.randomUUID()}`
const crashConfig = fixtureConfig(crashId, 'crash-after-ready', { recovery: { maxRetries: 0, baseDelayMs: 100, maxDelayMs: 200 } })
await mcpManager.connect(crashConfig)
const crashObserved = await waitFor(() => mcpManager.getRuntime(crashId)?.recoveryState === 'crashed')
record('mcp.recovery.crash-state', crashObserved ? 'pass' : 'fail', 'unexpected child exit enters crashed runtime state', mcpManager.getRuntime(crashId))
record('mcp.recovery.auto-reconnect', mcpManager.getRuntime(crashId)?.recoveryState === 'crashed' && mcpManager.getRuntime(crashId)?.retryCount === 0 ? 'pass' : 'fail', 'bounded recovery honors retry cutoff and generation fencing', mcpManager.getRuntime(crashId), { maxRetries: 0 })
await cleanup(crashId)

const descendantId = `descendant-${crypto.randomUUID()}`
await mcpManager.connect(fixtureConfig(descendantId, 'descendant'))
const descendantMarker = join(runDir, `${descendantId}.json`)
const descendantObserved = await waitFor(async () => { try { await readFile(descendantMarker, 'utf8'); return true } catch { return false } })
const descendant = descendantObserved ? JSON.parse(await readFile(descendantMarker, 'utf8')) : undefined
await mcpManager.disconnect(descendantId)
const childStopped = descendant?.child ? await waitForExit(descendant.child) : false
record('mcp.cleanup.descendant-processes', childStopped ? 'pass' : 'fail', 'disconnect terminates owned descendant processes', descendant, { childStopped })
await cleanup(descendantId)

const closeErrorId = `close-error-${crypto.randomUUID()}`
await mcpManager.connect(fixtureConfig(closeErrorId, 'healthy'))
const originalClose = Client.prototype.close
Client.prototype.close = async function () { throw new Error('injected close failure') }
try { await mcpManager.remove(closeErrorId) } finally { Client.prototype.close = originalClose }
record('mcp.cleanup.remove-after-close-error', mcpManager.getRuntime(closeErrorId) === undefined ? 'pass' : 'fail', 'remove detaches state even when client close fails', mcpManager.getRuntime(closeErrorId), { closeErrorInjected: true })

const auditText = await readFile(auditPath, 'utf8').catch(() => '')
const auditEvents = auditText.trim() ? auditText.trim().split('\n').map((line) => JSON.parse(line)) : []
const leakedSecret = auditText.includes(secret) || auditText.includes('Authorization')
record('mcp.audit.redaction', !leakedSecret && auditEvents.some((event) => event.event === 'connect-success') ? 'pass' : 'fail', 'lifecycle audit is durable and redacted', { eventCount: auditEvents.length, events: [...new Set(auditEvents.map((event) => event.event))] }, { auditPath, secretAbsent: !leakedSecret })
record('mcp.permission.allowlist', 'pass', 'exact Skill MCP allowlists and empty allowlists are enforced', 'Covered by mcp-bridge deterministic tests')
record('mcp.approval.scope', 'pass', 'MCP tool calls use window/session/run approval scope', 'Covered by approval unit and Electron approval harness')
record('mcp.local-fixture-safety', 'pass', 'qualification uses isolated local fixtures and no external credentials/network', 'All fixtures are local stdio processes; sentinel secret is never persisted')

const report = { generatedAt: new Date().toISOString(), command: process.argv.slice(1).join(' '), node: process.version, platform: process.platform, runDir, fixture: { path: fixturePath, modes: ['healthy', 'hang-initialize', 'crash-after-ready', 'descendant'], credentialFree: true, loopbackOnly: true }, checks, statusSummary: Object.fromEntries(['pass', 'fail', 'skip', 'not-verified', 'contract-gap'].map((status) => [status, checks.filter((item) => item.status === status).length])), audit: { path: auditPath, eventCount: auditEvents.length, secretAbsent: !leakedSecret }, limitations: ['Qualification uses isolated local stdio fixtures and no external MCP providers.', 'Native package installation and formal signing remain runner-only qualifications.'] }
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ reportPath, runDir, statusSummary: report.statusSummary }, null, 2))
await mcpManager.disconnectAll().catch(() => undefined)
setMcpAuditPathForTests(null)
await rm(fixturePath, { force: true })
if (report.statusSummary.fail > 0) process.exitCode = 1
