import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { chromium } from 'playwright-core'

type Target = Record<string, unknown>
type Request = {
  version: number
  isolated: boolean
  evidence_limits: { console?: number; network?: number; snapshotNodes?: number; textChars?: number }
  request: {
    operation: string
    page_id?: string
    url?: string
    target?: Target
    value?: string
    timeout_ms?: number
    include?: string[]
    screenshot_path?: string
    download_path?: string
  }
}
type StoredPage = { id: string; url: string; profile: string }

const statePath = (): string => resolve(process.cwd(), 'output', 'browser', '.browser-inspect-pages.json')
const browserPath = (): string | null => {
  const candidates = [
    process.env.BROWSER_INSPECT_EXECUTABLE,
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  ].filter((value): value is string => Boolean(value))
  return candidates.find((value) => existsSync(value)) ?? null
}
function loadState(): Record<string, StoredPage> {
  try { return JSON.parse(readFileSync(statePath(), 'utf8')) as Record<string, StoredPage> } catch { return {} }
}
function saveState(value: Record<string, StoredPage>): void {
  const path = statePath(); mkdirSync(resolve(path, '..'), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`; writeFileSync(temp, JSON.stringify(value), 'utf8'); renameSync(temp, path)
}
function safeUrl(raw: string): string {
  const url = new URL(raw)
  for (const key of [...url.searchParams.keys()]) if (/token|secret|key|auth|password|session|code/i.test(key)) url.searchParams.set(key, '[redacted]')
  return url.toString()
}
function selector(target: Target | undefined): string {
  if (!target) throw new Error('A semantic target is required')
  if (typeof target.css === 'string') return target.css
  if (typeof target.selector === 'string') return target.selector
  if (typeof target.text === 'string') return `text=${target.text}`
  if (typeof target.label === 'string') return `label=${target.label}`
  if (typeof target.role === 'string') return `[role="${target.role}"]${typeof target.name === 'string' ? `:has-text("${target.name.replace(/"/g, '\\"')}")` : ''}`
  throw new Error('A semantic target is required')
}
function artifact(input: string | undefined): string {
  if (!input || !input.startsWith('output/browser/') || input.includes('..') || input.includes('\\')) throw new Error('Artifact path must remain under output/browser')
  const root = resolve(process.cwd(), 'output', 'browser'); const path = resolve(process.cwd(), input)
  if (!path.startsWith(`${root}\\`) && path !== root) throw new Error('Artifact path must remain under output/browser')
  mkdirSync(resolve(path, '..'), { recursive: true }); return path
}
async function evidence(page: { locator(selector: string): { evaluateAll<T>(fn: (items: Element[], arg: number) => T, arg: number): Promise<T>; innerText(): Promise<string> } }, limits: Request['evidence_limits']): Promise<Record<string, unknown>> {
  const maxNodes = limits.snapshotNodes ?? 200
  const nodes = await page.locator('button, input, textarea, select, a, [role]').evaluateAll((items, limit) => items.slice(0, limit).map((item, index) => ({
    ref: `e${index + 1}`,
    role: item.getAttribute('role') ?? item.tagName.toLowerCase(),
    name: (item.getAttribute('aria-label') || item.textContent || '').trim().slice(0, 512),
    state: { disabled: (item as HTMLInputElement).disabled === true }
  })), maxNodes)
  const text = (await page.locator('body').innerText().catch(() => '')).slice(0, limits.textChars ?? 20000)
  return { snapshot: { nodes, text, truncated: nodes.length >= maxNodes } }
}
async function execute(payload: Request): Promise<Record<string, unknown>> {
  const request = payload.request; const executablePath = browserPath()
  if (!executablePath) return { ok: false, blocked: false, error: { code: 'driver_unavailable', message: 'No approved Chromium-family browser executable is installed.' } }
  const state = loadState(); let record = request.page_id ? state[request.page_id] : undefined
  const id = record?.id ?? randomUUID(); const profile = record?.profile ?? resolve(process.cwd(), 'output', 'browser', '.profiles', id)
  const context = await chromium.launchPersistentContext(profile, { executablePath, headless: true, viewport: { width: 1280, height: 800 } })
  try {
    let page = context.pages()[0] ?? await context.newPage()
    const events: { console: unknown[]; network: unknown[] } = { console: [], network: [] }
    page.on('console', (message) => events.console.push({ level: message.type(), text: message.text().slice(0, 2000), timestamp: Date.now() }))
    page.on('response', (response) => events.network.push({ method: response.request().method(), status: response.status(), url: safeUrl(response.url()), content_type: response.headers()['content-type'] ?? '', content_length: Number(response.headers()['content-length'] ?? 0) }))
    if (request.operation === 'open') {
      if (!request.url) throw new Error('url is required')
      await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: request.timeout_ms ?? 30000 })
      record = { id, url: request.url, profile }; state[id] = record; saveState(state)
    } else {
      if (!record) return { ok: false, blocked: true, error: { code: 'unknown_page', message: 'Unknown or closed page identifier.' } }
      await page.goto(record.url, { waitUntil: 'domcontentloaded', timeout: request.timeout_ms ?? 30000 })
      if (request.operation === 'click') await page.locator(selector(request.target)).click()
      if (request.operation === 'fill') await page.locator(selector(request.target)).fill(request.value ?? '')
      if (request.operation === 'press') await page.locator(selector(request.target)).press(request.value ?? 'Enter')
      if (request.operation === 'select') await page.locator(selector(request.target)).selectOption(request.value ?? '')
      if (request.operation === 'wait') await page.waitForTimeout(Math.min(Number(request.value ?? 0), request.timeout_ms ?? 30000))
      if (request.operation === 'screenshot') await page.screenshot({ path: artifact(request.screenshot_path), fullPage: true })
      if (request.operation === 'close') { delete state[id]; saveState(state) }
    }
    const report = await evidence(page, payload.evidence_limits)
    return { ok: true, blocked: false, page_id: id, url: safeUrl(page.url()), title: await page.title(), console: events.console.slice(-50), network: events.network.slice(-50), ...report }
  } catch (error) {
    return { ok: false, blocked: false, error: { code: 'driver_failed', message: error instanceof Error ? error.message.slice(0, 500) : String(error) } }
  } finally { await context.close() }
}

if (process.argv.includes('--probe')) {
  process.exitCode = browserPath() ? 0 : 1
} else {
  let buffer = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { buffer += chunk }); process.stdin.on('end', async () => process.stdout.write(JSON.stringify(await execute(JSON.parse(buffer)))))
}
