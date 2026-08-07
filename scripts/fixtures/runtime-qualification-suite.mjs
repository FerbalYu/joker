// Runtime qualification suite (TOOL-FORGE-PLAN.md §8.2 / §8.2.1, P0).
//
// Pure .mjs on purpose: it must run identically under plain Node (dev
// environment) and under the Electron binary (packaged-environment proxy),
// so it never imports TypeScript. It returns raw case results; level
// derivation happens in src/main/generated-tools/qualification.ts.
//
// Candidates:
//   quickjs-wasm  — WASM QuickJS; the guest realm has no host APIs at all,
//                   all capabilities arrive through the injected broker.
//   node-vm       — control group: classic `constructor.constructor` escape
//                   reaches the host realm, proving the harness detects
//                   escapes (node:vm is NOT a security boundary).
//   child-process — OS-level subprocess with scrubbed env; lifecycle works
//                   but raw host access is unblockable.

import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { createContext, runInContext } from 'node:vm'

export const MANDATORY_CASE_IDS = [
  'legit-execution',
  'workspace-boundary',
  'network-denied',
  'subprocess-denied',
  'env-denied',
  'timeout-cleanup',
  'cancel-cleanup',
  'ipc-registry-audit-isolation'
]
export const PACKAGED_EQUIVALENCE_CASE_ID = 'packaged-equivalence'
export const CANDIDATE_IDS = ['quickjs-wasm', 'node-vm', 'child-process']

export const SAMPLE_TOOL_SOURCE = readFileSync(
  new URL('./generated-tools/summarize-task-json/source/tool.js', import.meta.url),
  'utf8'
)
export const SAMPLE_EXPECTED_OUTPUT = 'open: 4\ndone: 3\nin_progress: 2'

const DEFAULT_CASE_TIMEOUT_MS = 10_000

// Env scrubbing mirrors src/main/tools/bash.ts buildSafeEnv (P0 keeps the
// candidate honest: whatever the parent passes is all the child can see).
const ENV_BLOCKLIST_PATTERNS = [
  /API_?KEY/i,
  /SECRET/i,
  /TOKEN/i,
  /PASSWORD/i,
  /CREDENTIAL/i,
  /AUTH/i,
  /PRIVATE_?KEY/i,
  /ACCESS_?KEY/i,
  /SESSION_?KEY/i,
  /ANTHROPIC/i,
  /OPENAI/i,
  /AWS/i,
  /AZURE/i,
  /GOOGLE/i,
  /GCP/i
]

function buildSafeEnv() {
  const safe = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (ENV_BLOCKLIST_PATTERNS.some((pattern) => pattern.test(key))) continue
    safe[key] = value
  }
  return safe
}

function killChildTree(child) {
  if (!child.pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already exited */
    }
  }
}

function isPathInside(root, target) {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

// ---------------------------------------------------------------------------
// The classic escape probe. Identical source text for every candidate; the
// outcome is what differs:
//   quickjs: the chain stays inside the engine realm — 'process' is undefined.
//   node-vm: the sandbox object's constructor chain reaches host Function,
//            which compiles in the host realm and returns host `process`.
//   child:   --eval wrapper `this` is module.exports of a plain host object.
const CLASSIC_ESCAPE_PROBE = `
  function rawProbe() {
    try { return this.constructor.constructor('return process')() } catch (e) { return null }
  }
`

// ---------------------------------------------------------------------------
// Runner adapters. Each returns { ok, output, error, terminatedByBudget } and
// guarantees that after every run its resources are disposed/killed so a
// follow-up run starts clean.

let quickjsModulePromise = null
function getQuickJSModule() {
  if (!quickjsModulePromise) {
    quickjsModulePromise = import('quickjs-emscripten').then((m) => m.newQuickJSWASMModule())
  }
  return quickjsModulePromise
}

function makeQuickJSRunner({ workspacePath }) {
  return {
    id: 'quickjs-wasm',
    async run(source, { timeoutMs = DEFAULT_CASE_TIMEOUT_MS, preAborted = false } = {}) {
      let output
      let error
      let terminatedByBudget = false
      let context = null
      const ownedHandles = []
      try {
        const qjs = await getQuickJSModule()
        context = qjs.newContext()
        const deadline = Date.now() + timeoutMs
        let cancelled = preAborted
        context.runtime.setInterruptHandler(() => (cancelled || Date.now() >= deadline ? true : undefined))
        const toolHandle = context.newObject()
        const readFileFn = context.newFunction('readFile', (pathHandle) => {
          const rel = context.dump(pathHandle)
          const abs = resolve(workspacePath, String(rel))
          if (!isPathInside(workspacePath, abs)) throw new Error('DENIED: path outside workspace')
          return context.newString(readFileSync(abs, 'utf8'))
        })
        const outputFn = context.newFunction('output', (textHandle) => {
          output = context.dump(textHandle)
        })
        context.setProp(toolHandle, 'readFile', readFileFn)
        context.setProp(toolHandle, 'output', outputFn)
        context.setProp(context.global, 'tool', toolHandle)
        ownedHandles.push(toolHandle, readFileFn, outputFn)
        const result = context.evalCode(source, 'tool.js')
        if (result.error) {
          const err = context.dump(result.error)
          result.error.dispose()
          error = err && typeof err === 'object' && err.message !== undefined ? String(err.message) : String(err)
          if (/interrupted|InternalError/i.test(error)) terminatedByBudget = true
        } else {
          result.value.dispose()
        }
      } catch (e) {
        error = String(e && e.message ? e.message : e)
        if (/interrupted|InternalError/i.test(error)) terminatedByBudget = true
      } finally {
        for (const handle of ownedHandles) {
          try {
            handle.dispose()
          } catch {
            /* already disposed by GC edge cases */
          }
        }
        if (context) {
          try {
            context.dispose()
          } catch {
            /* best effort */
          }
        }
      }
      return { ok: error === undefined && output !== undefined, output, error, terminatedByBudget }
    }
  }
}

function makeVmRunner({ workspacePath }) {
  return {
    id: 'node-vm',
    async run(source, { timeoutMs = DEFAULT_CASE_TIMEOUT_MS, preAborted = false } = {}) {
      let output
      let error
      let terminatedByBudget = false
      // vm is synchronous: an already-aborted request is enforced through the
      // execution timeout, never cooperatively.
      const effectiveTimeout = preAborted ? Math.min(timeoutMs, 50) : timeoutMs
      const tool = {
        readFile: (rel) => {
          const abs = resolve(workspacePath, String(rel))
          if (!isPathInside(workspacePath, abs)) throw new Error('DENIED: path outside workspace')
          return readFileSync(abs, 'utf8')
        },
        output: (text) => {
          output = String(text)
        }
      }
      const context = createContext({ tool })
      try {
        runInContext(source, context, { timeout: effectiveTimeout, filename: 'tool.js' })
      } catch (e) {
        error = String(e && e.message ? e.message : e)
        if (/timed out|terminated|Script execution/i.test(error)) terminatedByBudget = true
      }
      return { ok: error === undefined && output !== undefined, output, error, terminatedByBudget }
    }
  }
}

function readAllowedWorkspaceFiles(workspacePath) {
  const allowed = {}
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.isFile()) {
        const rel = relative(workspacePath, p).split('\\').join('/')
        allowed[rel] = readFileSync(p, 'utf8')
      }
    }
  }
  walk(workspacePath)
  return allowed
}

function makeChildProcessRunner({ workspacePath }) {
  return {
    id: 'child-process',
    async run(source, { timeoutMs = DEFAULT_CASE_TIMEOUT_MS, preAborted = false } = {}) {
      return new Promise((resolvePromise) => {
        const allowed = readAllowedWorkspaceFiles(workspacePath)
        const prelude = `
          const ALLOWED = ${JSON.stringify(allowed)}
          globalThis.__out__ = undefined
          const tool = {
            readFile: (p) => {
              const k = String(p).replace(/\\\\/g, '/')
              if (Object.prototype.hasOwnProperty.call(ALLOWED, k)) return ALLOWED[k]
              throw new Error('DENIED: path outside workspace')
            },
            output: (t) => { globalThis.__out__ = String(t) }
          }
        `
        const script =
          prelude +
          source +
          "\n;console.log('TOOL_RESULT:' + JSON.stringify({ ok: globalThis.__out__ !== undefined, output: globalThis.__out__ ?? null }))"
        const child = spawn(process.execPath, ['--eval', script], {
          cwd: workspacePath,
          env: buildSafeEnv(),
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (d) => {
          stdout += d
        })
        child.stderr.on('data', (d) => {
          stderr += d
        })
        let settled = false
        let terminatedByBudget = false
        const finish = (result) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          killChildTree(child)
          resolvePromise({ ...result, terminatedByBudget })
        }
        const timer = setTimeout(() => {
          terminatedByBudget = true
          finish({ ok: false, output: undefined, error: 'timeout' })
        }, timeoutMs)
        if (preAborted) {
          terminatedByBudget = true
          finish({ ok: false, output: undefined, error: 'cancelled' })
          return
        }
        child.on('exit', () => {
          const match = stdout.match(/TOOL_RESULT:(\{.*\})\s*$/)
          if (!match) {
            finish({ ok: false, output: undefined, error: `no TOOL_RESULT; stderr: ${stderr.slice(-500)}` })
            return
          }
          try {
            const parsed = JSON.parse(match[1])
            finish({ ok: parsed.ok, output: parsed.output, error: undefined })
          } catch (e) {
            finish({ ok: false, output: undefined, error: `bad protocol: ${e.message}` })
          }
        })
        child.on('error', (e) => finish({ ok: false, output: undefined, error: `spawn error: ${e.message}` }))
      })
    }
  }
}

function makeRunner(candidateId, { workspacePath }) {
  if (candidateId === 'quickjs-wasm') return makeQuickJSRunner({ workspacePath })
  if (candidateId === 'node-vm') return makeVmRunner({ workspacePath })
  if (candidateId === 'child-process') return makeChildProcessRunner({ workspacePath })
  throw new Error(`unknown candidate: ${candidateId}`)
}

// ---------------------------------------------------------------------------
// Cases. Each is (runner, ctx) -> { status, details }.

function pass(details) {
  return { status: 'pass', details }
}
function fail(details) {
  return { status: 'fail', details }
}
function skipped(details) {
  return { status: 'skipped', details }
}

async function caseLegitExecution(runner, ctx) {
  const result = await runner.run(SAMPLE_TOOL_SOURCE, { timeoutMs: ctx.caseTimeoutMs })
  if (!result.ok || result.error) return fail(`runner error: ${result.error ?? 'no output'}`)
  if (result.output !== SAMPLE_EXPECTED_OUTPUT) {
    return fail(`output mismatch: ${JSON.stringify(result.output)}`)
  }
  return pass('sample tool produced the exact expected output')
}

async function caseWorkspaceBoundary(runner, ctx) {
  const outsideAbs = join(ctx.runDir, 'secret.txt')
  const source = `
    let report = ''
    try { tool.readFile('../secret.txt'); report += 'broker-rel-escaped:' } catch (e) { report += 'broker-rel-denied:' }
    try { tool.readFile(${JSON.stringify(outsideAbs)}); report += 'broker-abs-escaped:' } catch (e) { report += 'broker-abs-denied:' }
    ${CLASSIC_ESCAPE_PROBE}
    const p = rawProbe()
    report += p && typeof p === 'object' ? 'raw-host-visible' : 'raw-denied'
    tool.output(report)
  `
  const result = await runner.run(source, { timeoutMs: ctx.caseTimeoutMs })
  if (result.error) return fail(`runner error: ${result.error}`)
  const out = result.output ?? ''
  const brokerDenied = out.includes('broker-rel-denied:') && out.includes('broker-abs-denied:')
  const rawDenied = out.includes('raw-denied')
  if (brokerDenied && rawDenied) {
    return pass('broker rejected relative and absolute escape paths; raw probe reached no host process')
  }
  return fail(`escape observed; report: ${out}`)
}

async function caseNetworkDenied(runner, ctx) {
  const hitsBefore = ctx.networkHits.count
  const source = `
    let report = ''
    ${CLASSIC_ESCAPE_PROBE}
    const p = rawProbe()
    if (!p) { report += 'raw-denied' } else {
      try {
        const hostFetch = p.constructor.constructor('return fetch')()
        hostFetch(${JSON.stringify(ctx.networkUrl)})
        report += 'fetch-called'
      } catch (e) { report += 'fetch-denied:' + e.name }
    }
    tool.output(report)
  `
  const result = await runner.run(source, { timeoutMs: ctx.caseTimeoutMs })
  if (result.error) return fail(`runner error: ${result.error}`)
  const out = result.output ?? ''
  // fetch dispatches asynchronously; give a dispatched request time to land.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
  const hits = ctx.networkHits.count - hitsBefore
  if (hits === 0 && /fetch-denied|raw-denied/.test(out)) {
    return pass(`no network request observed; report: ${out}`)
  }
  return fail(`network request observed (hits=${hits}); report: ${out}`)
}

async function caseSubprocessDenied(runner, ctx) {
  // Forward slashes keep the embedded path valid as a JS string literal in
  // the spawned probe (backslashes would be consumed as escapes).
  const markerAbs = join(ctx.workspacePath, 'subprocess-marker.txt').split('\\').join('/')
  rmSync(markerAbs, { force: true })
  const source = `
    let report = ''
    ${CLASSIC_ESCAPE_PROBE}
    const p = rawProbe()
    if (p && p.getBuiltinModule) {
      try {
        const cp = p.getBuiltinModule('child_process')
        // Double-stringify: the outer literal embeds a path that itself is
        // quoted, so the spawned -e script sees a proper string argument.
        const r = cp.spawnSync(p.execPath, ['-e', 'require("fs").writeFileSync(' + ${JSON.stringify(JSON.stringify(markerAbs))} + ',"x")'])
        report += 'spawn-status:' + (r.status === 0 ? 'ok' : 'err')
      } catch (e) { report += 'spawn-denied:' + e.name }
    } else { report += 'spawn-denied' }
    tool.output(report)
  `
  const result = await runner.run(source, { timeoutMs: ctx.caseTimeoutMs })
  if (result.error) return fail(`runner error: ${result.error}`)
  const out = result.output ?? ''
  if (!existsSync(markerAbs) && out.includes('spawn-denied')) {
    return pass(`no subprocess could be started; report: ${out}`)
  }
  return fail(`subprocess started (marker present=${existsSync(markerAbs)}); report: ${out}`)
}

async function caseEnvDenied(runner, ctx) {
  const secretName = 'JOKER_QUALIFICATION_SECRET'
  const source = `
    let report = ''
    ${CLASSIC_ESCAPE_PROBE}
    const p = rawProbe()
    if (p && p.env) {
      report += 'env-visible:' + Object.keys(p.env).length
      report += p.env[${JSON.stringify(secretName)}] ? ';secret-visible' : ';secret-hidden'
    } else { report += 'env-denied' }
    tool.output(report)
  `
  const result = await runner.run(source, { timeoutMs: ctx.caseTimeoutMs })
  if (result.error) return fail(`runner error: ${result.error}`)
  const out = result.output ?? ''
  if (out === 'env-denied') {
    return pass(`environment is not visible to the tool`)
  }
  return fail(`environment visible; report: ${out}`)
}

async function caseTimeoutCleanup(runner, ctx) {
  const result = await runner.run('while (true) { }', { timeoutMs: 3000 })
  if (!result.terminatedByBudget) return fail(`infinite loop not stopped: ${result.error ?? 'completed'}`)
  const followUp = await runner.run('tool.output("alive")', { timeoutMs: 3000 })
  if (!followUp.ok || followUp.output !== 'alive') {
    return fail(`runner not reusable after stop: ${followUp.error ?? JSON.stringify(followUp.output)}`)
  }
  return pass(`stopped by budget (${result.error}) and runner remained usable`)
}

async function caseCancelCleanup(runner, ctx) {
  const result = await runner.run('while (true) { }', { timeoutMs: 3000, preAborted: true })
  if (!result.terminatedByBudget) return fail(`aborted run not stopped: ${result.error ?? 'completed'}`)
  const followUp = await runner.run('tool.output("alive")', { timeoutMs: 3000 })
  if (!followUp.ok || followUp.output !== 'alive') {
    return fail(`runner not reusable after cancel: ${followUp.error ?? JSON.stringify(followUp.output)}`)
  }
  return pass(`cancelled run stopped (${result.error}) and runner remained usable`)
}

async function caseIpcRegistryAuditIsolation(runner, ctx) {
  const canaryAbs = join(ctx.runDir, 'canary-registry.json')
  writeFileSync(canaryAbs, 'original', 'utf8')
  const source = `
    let report = ''
    ${CLASSIC_ESCAPE_PROBE}
    const p = rawProbe()
    if (p && p.getBuiltinModule) {
      try {
        const fs = p.getBuiltinModule('fs')
        fs.writeFileSync(${JSON.stringify(canaryAbs)}, 'tampered')
        report += 'write-ok'
      } catch (e) { report += 'write-denied:' + e.name }
    } else { report += 'write-denied' }
    tool.output(report)
  `
  const result = await runner.run(source, { timeoutMs: ctx.caseTimeoutMs })
  if (result.error) return fail(`runner error: ${result.error}`)
  const out = result.output ?? ''
  const tampered = readFileSync(canaryAbs, 'utf8') !== 'original'
  if (!tampered && out.includes('write-denied')) {
    return pass(`cannot write registry/audit canary; report: ${out}`)
  }
  return fail(`canary writable (tampered=${tampered}); report: ${out}`)
}

// Only in the packaged environment: the qualifying candidate must behave
// identically under the Electron binary — same legit output, same boundary
// rejection.
async function casePackagedEquivalence(runner, ctx) {
  const legit = await caseLegitExecution(runner, ctx)
  if (legit.status !== 'pass') return fail(`legit execution differs in packaged env: ${legit.details}`)
  const boundary = await caseWorkspaceBoundary(runner, ctx)
  if (boundary.status !== 'pass') return fail(`boundary rejection differs in packaged env: ${boundary.details}`)
  return pass('legit execution and boundary rejection behave identically under electron')
}

const CASES = {
  'legit-execution': caseLegitExecution,
  'workspace-boundary': caseWorkspaceBoundary,
  'network-denied': caseNetworkDenied,
  'subprocess-denied': caseSubprocessDenied,
  'env-denied': caseEnvDenied,
  'timeout-cleanup': caseTimeoutCleanup,
  'cancel-cleanup': caseCancelCleanup,
  'ipc-registry-audit-isolation': caseIpcRegistryAuditIsolation,
  'packaged-equivalence': casePackagedEquivalence
}

async function startNetworkProbeServer() {
  const hits = { count: 0 }
  const server = createServer((req, res) => {
    hits.count += 1
    res.writeHead(200)
    res.end()
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}/leak`,
    hits,
    close: () =>
      new Promise((resolvePromise) => {
        server.close(resolvePromise)
      })
  }
}

/**
 * Runs every candidate against every applicable case for one environment.
 * Returns a raw matrix (no level). Evidence files for passing cases are
 * written under `evidenceDir`; the frozen report is assembled by the caller.
 */
export async function runQualificationSuite({
  env,
  runDir,
  workspacePath,
  evidenceDir,
  caseTimeoutMs = DEFAULT_CASE_TIMEOUT_MS,
  candidateIds = CANDIDATE_IDS
}) {
  process.env['JOKER_QUALIFICATION_SECRET'] ??= 'joker-qualification-secret-canary'
  const startedAt = Date.now()
  const server = await startNetworkProbeServer()
  const ctx = {
    workspacePath,
    runDir,
    caseTimeoutMs,
    networkUrl: server.url,
    networkHits: server.hits,
    evidenceDir
  }
  const candidates = []
  try {
    for (const candidateId of candidateIds) {
      let candidateResult
      try {
        const runner = makeRunner(candidateId, { workspacePath })
        const cases = []
        for (const caseId of [...MANDATORY_CASE_IDS, ...(env === 'packaged' ? [PACKAGED_EQUIVALENCE_CASE_ID] : [])]) {
          try {
            const { status, details } = await CASES[caseId](runner, ctx)
            const evidencePath = `${candidateId}-${caseId}.json`
            writeFileSync(
              join(evidenceDir, evidencePath),
              JSON.stringify({ candidate: candidateId, env, caseId, status, details, at: new Date().toISOString() }, null, 2)
            )
            cases.push({
              id: caseId,
              status,
              details,
              ...(status === 'pass' ? { evidencePath } : {})
            })
          } catch (e) {
            const details = `case harness error: ${String(e && e.message ? e.message : e)}`
            const evidencePath = `${candidateId}-${caseId}.json`
            writeFileSync(
              join(evidenceDir, evidencePath),
              JSON.stringify({ candidate: candidateId, env, caseId, status: 'inconclusive', details, at: new Date().toISOString() }, null, 2)
            )
            cases.push({ id: caseId, status: 'inconclusive', details })
          }
        }
        candidateResult = { candidate: candidateId, env, passesIsolation: false, cases }
      } catch (e) {
        candidateResult = {
          candidate: candidateId,
          env,
          passesIsolation: false,
          cases: [],
          error: String(e && e.message ? e.message : e)
        }
      }
      candidates.push(candidateResult)
    }
    return { generatedAt: Date.now(), startedAt, finishedAt: Date.now(), environment: env, candidates }
  } finally {
    await server.close()
  }
}
