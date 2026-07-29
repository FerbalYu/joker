import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import type { WebReadOptions } from './web'
import { assertPublicWebUrl } from './web'

const BROWSER_WAIT_MS = 2_500
const MAX_BROWSER_TEXT = 1_500_000

export interface BrowserReadResult {
  finalUrl: string
  title?: string
  text: string
  status?: number
  contentType?: string
}

export interface BrowserReadDependencies {
  assertPublicUrl: (value: string | URL) => Promise<URL>
}

const defaultBrowserReadDependencies: BrowserReadDependencies = {
  assertPublicUrl: async (value) => assertPublicWebUrl(value)
}

function browserCandidates(): string[] {
  if (process.env.JOKER_BROWSER_PATH) return [process.env.JOKER_BROWSER_PATH]
  if (process.platform !== 'win32') {
    return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  }
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const localAppData = process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Local')
  return [
    join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ]
}

export function findBrowserExecutable(): string | null {
  return browserCandidates().find((candidate) => existsSync(candidate)) ?? null
}

async function createBrowser(): Promise<Browser> {
  const executablePath = findBrowserExecutable()
  if (!executablePath) throw new Error('No supported Chrome or Edge browser was found')
  return chromium.launch({
    headless: true,
    executablePath,
    args: ['--disable-background-networking', '--disable-sync', '--no-first-run']
  })
}

function isAllowedRequest(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

async function installRequestGuard(context: BrowserContext, assertPublicUrl: BrowserReadDependencies['assertPublicUrl']): Promise<void> {
  await context.route('**/*', async (route) => {
    const requestUrl = route.request().url()
    if (!isAllowedRequest(requestUrl)) {
      await route.abort('blockedbyclient')
      return
    }
    try {
      await assertPublicUrl(requestUrl)
      await route.continue()
    } catch {
      await route.abort('blockedbyclient')
    }
  })
}

async function waitForReadableText(page: Page, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + Math.min(BROWSER_WAIT_MS, Math.max(500, timeoutMs))
  let previousLength = 0
  let stableRounds = 0
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError')
    const length = await page.evaluate(() => document.body?.innerText?.trim().length ?? 0).catch(() => 0)
    if (length > 0 && length === previousLength) {
      stableRounds += 1
      if (stableRounds >= 2) return
    } else {
      stableRounds = 0
    }
    previousLength = length
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 250)
      const abort = (): void => { clearTimeout(timer); reject(signal?.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError')) }
      signal?.addEventListener('abort', abort, { once: true })
    })
  }
}

export async function readRenderedPage(url: string, options: Required<WebReadOptions>, signal?: AbortSignal, dependencies: BrowserReadDependencies = defaultBrowserReadDependencies): Promise<BrowserReadResult> {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError')
  await dependencies.assertPublicUrl(url)
  const browser = await createBrowser()
  let context: BrowserContext | undefined
  let page: Page | undefined
  try {
    context = await browser.newContext({
      javaScriptEnabled: true,
      serviceWorkers: 'block',
      ignoreHTTPSErrors: false
    })
    await installRequestGuard(context, dependencies.assertPublicUrl)
    page = await context.newPage()
    const abortBrowser = (): void => { void page?.close().catch(() => undefined); void context?.close().catch(() => undefined) }
    signal?.addEventListener('abort', abortBrowser, { once: true })
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs })
      await waitForReadableText(page, options.timeoutMs, signal)
      const result = await page.evaluate((maxText) => {
        const body = document.body
        const text = body?.innerText?.trim() ?? ''
        return {
          title: document.title?.trim() || undefined,
          url: location.href,
          text: text.slice(0, maxText),
          contentType: document.contentType || undefined
        }
      }, MAX_BROWSER_TEXT)
      return {
        finalUrl: result.url,
        title: result.title,
        text: result.text,
        status: response?.status(),
        contentType: result.contentType
      }
    } finally {
      signal?.removeEventListener('abort', abortBrowser)
    }
  } finally {
    await page?.close().catch(() => undefined)
    await context?.close().catch(() => undefined)
    await browser.close().catch(() => undefined)
  }
}
