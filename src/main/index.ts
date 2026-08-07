import { app, shell, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { is, optimizer } from '@electron-toolkit/utils'
import { retireStreaming, setupStreaming } from './stream'
import { registerApprovalIpc } from './agent/approval'
import { registerConfigIpc } from './ipc/config'
import { registerMcpIpc, restoreMcpServers } from './ipc/mcp'
import { registerSessionIpc } from './ipc/sessions'
import { registerSkillIpc } from './ipc/skill'
import { registerWebIpc } from './ipc/web'
import { registerFileIpc } from './ipc/file-register'
import { registerMarkdownIpc } from './ipc/markdown'
import { registerImageConfigIpc } from './ipc/image-config'
import { registerGeneratedImageIpc } from './ipc/generated-image'
import { registerGeneratedToolsIpc } from './ipc/generated-tools'
import { registerProjectIpc } from './ipc/projects'
import { closeMarkdownWindow } from './markdown-window'
import { runPackagedGeneratedToolQualification } from './generated-tools/runtime/packaged-qualification'
import { runPackagedGeneratedToolFixtureQualification } from './generated-tools/runtime/packaged-fixture-qualification'
import { runPackagedGate2Qualification } from './generated-tools/runtime/packaged-gate2-qualification'
import { runPackagedGate4EditQualification } from './generated-tools/runtime/packaged-gate4-edit-qualification'
import { ForgeService } from './generated-tools/forge-service'
import { PromotionService } from './generated-tools/promotion-service'
import { setDefaultForgeService, setDefaultPromotionService, stopDefaultForgeService } from './generated-tools/forge-service-runtime'
import { ContinuationScheduler } from './generated-tools/continuation-scheduler'
import { setDefaultContinuationScheduler } from './generated-tools/continuation-scheduler-runtime'
import { installSummarizeTaskJsonFixture } from './generated-tools/fixture'
import { RuntimeQualificationService } from './generated-tools/runtime-qualification-service'
import { setDefaultRuntimeQualificationService, stopDefaultRuntimeQualificationService } from './generated-tools/runtime-qualification-service-runtime'
import { getJokerHomeDir } from './store/paths'


let shuttingDown = false

const STREAM_QA_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>JOKER Stream QA</title></head><body><main id="status">stream QA loading</main><script>
(function () {
  const runs = new Map()
  let port = null
  let consumerDelayMs = 0
  let portError = null
  let flowState = null
  const flowEvents = []
  const completedRuns = new Set()
  let lateEventCount = 0
  function busyWait(ms) {
    const deadline = performance.now() + Math.max(0, ms)
    while (performance.now() < deadline) {}
  }
  function getRun(runId, sessionId) {
    let run = runs.get(runId)
    if (!run) {
      run = { runId, sessionId, firstTypes: [], lastTypes: [], tokenCount: 0, tokenIndices: [], nextTokenIndex: 0, outOfOrder: 0, typeCounts: {}, terminalCounts: { abort: 0, done: 0 }, startedAt: performance.now(), endedAt: null }
      runs.set(runId, run)
    }
    return run
  }
  function record(event) {
    const runId = event.runId || 'missing-run'
    if (completedRuns.has(runId)) lateEventCount += 1
    const run = getRun(runId, event.sessionId || 'missing-session')
    run.typeCounts[event.type] = (run.typeCounts[event.type] || 0) + 1
    if (run.firstTypes.length < 8) run.firstTypes.push(event.type)
    run.lastTypes.push(event.type)
    if (run.lastTypes.length > 8) run.lastTypes.shift()
    if (event.type === 'token') {
      run.tokenCount += 1
      const match = /^stream-token-(\\d+);$/.exec(event.text || '')
      if (match) {
        const index = Number(match[1])
        if (run.tokenIndices.length < 8) run.tokenIndices.push(index)
        else run.tokenIndices.shift()
        if (index !== run.nextTokenIndex) run.outOfOrder += 1
        run.nextTokenIndex = index + 1
      }
    }
    if (event.type === 'abort' || event.type === 'done') run.terminalCounts[event.type] += 1
    if (event.type === 'done') {
      run.endedAt = performance.now()
      completedRuns.add(runId)
    }
    busyWait(consumerDelayMs)
  }
  function snapshot() {
    return {
      portReady: Boolean(port),
      portError,
      consumerDelayMs,
      performanceMemory: performance.memory ? { usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize } : null,
      flowState,
      flowEvents,
      lateEventCount,
      runs: [...runs.values()].map((run) => ({ ...run, elapsedMs: run.endedAt === null ? null : run.endedAt - run.startedAt }))
    }
  }
  window.__jokerStreamQa = {
    setConsumerDelay(ms) { consumerDelayMs = Math.max(0, Number(ms) || 0) },
    async send(sessionId, messages, runId) {
      if (!port) throw new Error('stream port is not ready')
      const durableMessages = messages.map((message) => ({
        ...message,
        id: message.id || 'stream-qa-' + runId + '-' + Math.random().toString(36).slice(2),
        createdAt: message.createdAt || Date.now()
      }))
      for (const message of durableMessages) {
        if (!(await window.joker.session.append(sessionId, message))) throw new Error('failed to persist stream QA message')
      }
      window.joker.chat.send(port, sessionId, durableMessages, 'auto', undefined, undefined, runId)
    },
    abort(runId) { window.joker.chat.abort(port, runId) },
    snapshot
  }
  window.joker.chat.onPort((receivedPort) => {
    port = receivedPort
    window.joker.chat.onEvent(receivedPort, record)
    window.joker.chat.onFlow((flow) => {
      flowState = flow
      if (flowEvents.length < 256) flowEvents.push(flow)
    })
    document.querySelector('#status').textContent = 'stream QA ready'
  })
})()
</script></body></html>`

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'JOKER',
    icon: app.isPackaged ? join(process.resourcesPath, 'logo.ico') : join(__dirname, '../../src/image/logo.ico'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  let streamingInstalled = false
  const installStreaming = (): void => {
    if (streamingInstalled || win.webContents.isDestroyed()) return
    streamingInstalled = true
    setupStreaming(win)
  }
  win.webContents.on('did-start-loading', () => {
    if (!streamingInstalled) return
    streamingInstalled = false
    retireStreaming(win.id, 'Renderer document reloading')
  })
  win.webContents.on('did-finish-load', installStreaming)
  win.webContents.on('render-process-gone', () => {
    streamingInstalled = false
    retireStreaming(win.id, 'Renderer process exited')
  })
  win.webContents.on('destroyed', () => retireStreaming(win.id, 'Renderer WebContents destroyed'))

  win.on('ready-to-show', () => {
    win.show()
    installStreaming()
  })

  win.webContents.setWindowOpenHandler((details) => {
    try {
      const url = new URL(details.url)
      if (url.protocol === 'http:' || url.protocol === 'https:') void shell.openExternal(url.toString())
    } catch {
      // Ignore unsafe external protocols.
    }
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else if (process.env['JOKER_E2E_STREAM'] === '1') {
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(STREAM_QA_HTML)}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(async () => {
  if (process.env['JOKER_HOME']?.trim()) app.setPath('home', process.env['JOKER_HOME'].trim())
  if (await runPackagedGeneratedToolQualification()) return
  if (await runPackagedGeneratedToolFixtureQualification()) return
  if (await runPackagedGate2Qualification()) return
  if (await runPackagedGate4EditQualification()) return
  const jokerHome = getJokerHomeDir()
  const qualificationService = new RuntimeQualificationService({ jokerHome })
  qualificationService.recover()
  setDefaultRuntimeQualificationService(qualificationService)
  const forgeService = new ForgeService({ jokerHome })
  const promotionService = new PromotionService({ jokerHome })
  const continuationScheduler = new ContinuationScheduler({ jokerHome })
  setDefaultForgeService(forgeService)
  setDefaultPromotionService(promotionService)
  setDefaultContinuationScheduler(continuationScheduler)
  continuationScheduler.recover()
  await promotionService.recover()
  forgeService.start()
  if (process.env['JOKER_INSTALL_TOOLFORGE_FIXTURE'] === '1') {
    installSummarizeTaskJsonFixture(jokerHome, Date.now(), {
      fixtureRoot: app.isPackaged
        ? join(process.resourcesPath, 'toolforge-fixture')
        : undefined
    })
  }
  app.setAppUserModelId('com.joker.app')
  registerConfigIpc()
  registerMcpIpc()
  registerSessionIpc()
  registerSkillIpc()
  registerWebIpc()
  registerFileIpc()
  registerMarkdownIpc()
  registerImageConfigIpc()
  registerGeneratedImageIpc()
  registerGeneratedToolsIpc()
  registerProjectIpc()
  await registerApprovalIpc()
  await restoreMcpServers()
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  if (process.env['JOKER_E2E_MULTIWINDOW'] === '1') {
    const secondary = createWindow()
    secondary.setTitle('JOKER Approval Test Window')
  }

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', (event) => {
  if (shuttingDown) return
  event.preventDefault()
  shuttingDown = true
  stopDefaultRuntimeQualificationService()
  void stopDefaultForgeService().finally(() => app.quit())
})

app.on('window-all-closed', () => {
  closeMarkdownWindow()
  if (process.platform !== 'darwin') {
    void import('./mcp/client').then(({ mcpManager }) => mcpManager.disconnectAll()).finally(() => app.quit())
  }
})
