import { createHash } from 'node:crypto'
import Module, { createRequire } from 'node:module'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { spawn } from 'node:child_process'

let cancelled = false
process.on('message', async (message) => {
  if (!message || typeof message !== 'object') return
  if (message.type === 'cancel') {
    cancelled = true
    return
  }
  if (message.type !== 'run') return
  cancelled = false
  try {
    process.send?.({ type: 'result', result: await run(message.request) })
  } catch (error) {
    process.send?.({ type: 'result', result: result('runtime-failed', { error: error instanceof Error ? error.message : String(error) }) })
  }
})

function resourceHash(resource) {
  return createHash('sha256').update(String(resource)).digest('hex')
}

function result(outcome, extra = {}) {
  return {
    outcome,
    ok: outcome === 'succeeded',
    capabilityEvents: [],
    durationMs: 0,
    terminatedByBudget: outcome === 'timed-out' || outcome === 'cancelled',
    ...extra
  }
}

function error(code, message) {
  return Object.assign(new Error(message), { code })
}

function assertActive() {
  if (cancelled) throw error('generated-tool-cancelled', 'cancelled')
}

function generatedModuleRoot(entrypointPath) {
  let current = dirname(entrypointPath)
  while (true) {
    if (existsSync(join(current, 'manifest.json'))) return current
    const parent = dirname(current)
    if (parent === current) return dirname(entrypointPath)
    current = parent
  }
}

function isInside(root, path) {
  const local = relative(root, path)
  return local === '' || (!local.startsWith('..') && !isAbsolute(local))
}

function forceGeneratedJavaScriptToCommonJs(entrypointPath) {
  const root = generatedModuleRoot(entrypointPath)
  const original = Module._extensions['.js']
  Module._extensions['.js'] = (module, filename) => {
    if (!isInside(root, filename)) return original(module, filename)
    module._compile(readFileSync(filename, 'utf8'), filename)
  }
  return () => { Module._extensions['.js'] = original }
}

function exportedHandler(exports) {
  if (typeof exports === 'function') return exports
  if (!exports || typeof exports !== 'object') return null
  for (const name of ['handle', 'execute', 'main', 'run', 'default']) {
    if (typeof exports[name] === 'function') return exports[name]
  }
  return null
}

async function run(request) {
  const startedAt = Date.now()
  const events = []
  const capability = (name, resource) => {
    events.push({
      sequence: events.length + 1,
      capability: name,
      decision: 'allowed',
      resourceHash: resourceHash(resource)
    })
  }
  const workspace = realpathSync.native(resolve(request.workspacePath))
  const fullPath = (resource, operation) => {
    const path = resolve(workspace, String(resource))
    capability(operation, path)
    return path
  }
  let terminal
  const tool = {
    writeFile(path, value) {
      assertActive()
      const target = fullPath(path, 'filesystem.write')
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, String(value), 'utf8')
    },
    appendFile(path, value) {
      assertActive()
      const target = fullPath(path, 'filesystem.write')
      mkdirSync(dirname(target), { recursive: true })
      appendFileSync(target, String(value), 'utf8')
    },
    readEnvironment(key) {
      assertActive()
      const name = String(key)
      capability('environment.read', name)
      return process.env[name]
    },
    readSecret(handle) {
      assertActive()
      const name = String(handle)
      capability('secrets.read', name)
      return request.secrets[name]
    },
    async fetch(url, init = {}) {
      assertActive()
      const parsed = new URL(String(url))
      const method = String(init.method ?? 'GET').toUpperCase()
      capability('network.request', `${parsed.protocol}//${parsed.hostname}:${method}`)
      const response = await globalThis.fetch(parsed, init)
      return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() }
    },
    run(command, args = [], options = {}) {
      assertActive()
      const name = String(command)
      capability('process.run', name)
      return new Promise((resolvePromise, reject) => {
        const suppliedOptions = options && typeof options === 'object' ? options : {}
        const child = spawn(name, args.map(String), {
          ...suppliedOptions,
          cwd: suppliedOptions.cwd ?? workspace,
          env: suppliedOptions.env ?? request.environment,
          shell: suppliedOptions.shell ?? false,
          windowsHide: true
        })
        let stdout = ''
        let stderr = ''
        child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
        child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
        child.once('error', reject)
        child.once('exit', (code, signal) => resolvePromise({ code, signal, stdout, stderr }))
      })
    },
    readFile(path) {
      assertActive()
      return readFileSync(fullPath(path, 'filesystem.write'), 'utf8')
    },
    exists(path) {
      assertActive()
      return existsSync(fullPath(path, 'filesystem.write'))
    },
    listFiles(path = '.') {
      assertActive()
      return readdirSync(fullPath(path, 'filesystem.write'), { withFileTypes: true }).map((entry) => ({ name: entry.name, directory: entry.isDirectory() }))
    },
    mkdir(path) {
      assertActive()
      mkdirSync(fullPath(path, 'filesystem.write'), { recursive: true })
    },
    rename(from, to) {
      assertActive()
      renameSync(fullPath(from, 'filesystem.write'), fullPath(to, 'filesystem.write'))
    },
    remove(path) {
      assertActive()
      rmSync(fullPath(path, 'filesystem.write'), { recursive: true, force: true })
    },
    output(value) {
      if (terminal) throw error('generated-tool-multiple-result', 'Generated Tool emitted multiple terminal results')
      terminal = { type: 'output', value }
    },
    fail(value) {
      if (terminal) throw error('generated-tool-multiple-result', 'Generated Tool emitted multiple terminal results')
      terminal = { type: 'fail', value }
    }
  }
  let restoreCommonJs = () => {}
  try {
    const localModule = { exports: {} }
    const entrypointPath = typeof request.entrypointPath === 'string' && request.entrypointPath
      ? resolve(request.entrypointPath)
      : null
    if (entrypointPath) restoreCommonJs = forceGeneratedJavaScriptToCommonJs(entrypointPath)
    const localRequire = createRequire(entrypointPath ?? import.meta.url)
    // Generated Node entrypoints commonly start with a shebang. Node strips it
    // before compilation, but Function does not, so normalize it here as well.
    const source = String(request.source).replace(/^\uFEFF?#![^\r\n]*(?:\r?\n|$)/, '')
    const execute = new Function('tool', 'input', 'require', 'module', 'exports', '__filename', '__dirname', `'use strict'; return (async () => { ${source}\n })()`)
    await execute(
      tool,
      request.input,
      localRequire,
      localModule,
      localModule.exports,
      entrypointPath ?? '',
      entrypointPath ? dirname(entrypointPath) : process.cwd()
    )
    const handler = exportedHandler(localModule.exports)
    if (!terminal && handler) {
      terminal = { type: 'output', value: await handler(request.input) }
    }
    assertActive()
    if (!terminal) return result('runtime-failed', { error: 'missing-terminal-result', capabilityEvents: events, durationMs: Date.now() - startedAt })
    return terminal.type === 'output'
      ? result('succeeded', { output: terminal.value, capabilityEvents: events, durationMs: Date.now() - startedAt })
      : result('tool-failed', { error: terminal.value, capabilityEvents: events, durationMs: Date.now() - startedAt })
  } catch (caught) {
    const outcome = cancelled || caught?.code === 'generated-tool-cancelled' ? 'cancelled' : 'runtime-failed'
    return result(outcome, {
      error: caught && typeof caught === 'object' && typeof caught.code === 'string'
        ? { code: caught.code, message: caught.message }
        : caught instanceof Error ? caught.message : String(caught),
      capabilityEvents: events,
      durationMs: Date.now() - startedAt
    })
  } finally {
    restoreCommonJs()
  }
}
