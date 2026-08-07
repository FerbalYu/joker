import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { WebReadOptions } from './web'

const BROWSER_NETWORK_DISABLED = 'Browser fallback network access is disabled; guarded HTTP fetch is required'

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

export async function readRenderedPage(_url: string, _options: Required<WebReadOptions>, signal?: AbortSignal, _dependencies?: BrowserReadDependencies): Promise<BrowserReadResult> {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError')
  throw new Error(BROWSER_NETWORK_DISABLED)
}
