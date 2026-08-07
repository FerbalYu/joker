import { createHash } from 'node:crypto'
import { parentPort } from 'node:worker_threads'

import { newQuickJSWASMModule } from 'quickjs-emscripten'

if (!parentPort) throw new Error('Generated Tool runner worker requires parentPort')

let cancelled = false
parentPort.on('message', async (message) => {
  if (!message || typeof message !== 'object') return
  if (message.type === 'cancel') {
    cancelled = true
    return
  }
  if (message.type !== 'run') return
  cancelled = false
  try {
    const result = await run(message.request)
    parentPort.postMessage({ type: 'result', result })
  } catch (error) {
    parentPort.postMessage({
      type: 'result',
      result: baseResult('runtime-failed', { error: error instanceof Error ? error.message : String(error) })
    })
  }
})

function resourceHash(path) {
  return createHash('sha256').update(String(path)).digest('hex')
}

function serializedBytes(value) {
  if (value === undefined) return 0
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function baseResult(outcome, extra = {}) {
  return {
    outcome,
    ok: outcome === 'succeeded',
    observedCapabilities: [],
    capabilityEvents: [],
    inputBytes: 0,
    outputBytes: 0,
    readBytes: 0,
    durationMs: 0,
    terminatedByBudget: outcome === 'timed-out' || outcome === 'cancelled',
    ...extra
  }
}

function structuredRuntimeError(code, message, details = {}) {
  const error = new Error(JSON.stringify({ code, message, ...details }))
  error.code = code
  return error
}

function runtimeErrorMessage(error) {
  return error && typeof error === 'object' && typeof error.code === 'string'
    ? JSON.stringify(error)
    : error instanceof Error ? error.message : String(error)
}

function parseRuntimeError(value) {
  if (typeof value !== 'string' || value[0] !== '{') return value
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && typeof parsed.code === 'string' ? parsed : value
  } catch {
    return value
  }
}

async function run(request) {
  const startedAt = Date.now()
  const deadline = request.deadline
  if (!Number.isFinite(deadline) || Date.now() >= deadline) {
    return baseResult('timed-out', { error: parseRuntimeError(structuredRuntimeError('generated-tool-timeout', 'Generated Tool deadline exceeded').message), durationMs: Date.now() - startedAt, terminatedByBudget: true })
  }
  const qjs = await newQuickJSWASMModule()
  if (Date.now() >= deadline) {
    return baseResult('timed-out', { error: parseRuntimeError(structuredRuntimeError('generated-tool-timeout', 'Generated Tool deadline exceeded').message), durationMs: Date.now() - startedAt, terminatedByBudget: true })
  }
  const runtime = qjs.newRuntime()
  runtime.setMemoryLimit(request.limits.maxMemoryBytes)
  runtime.setMaxStackSize(Math.min(1_048_576, Math.max(64_000, Math.floor(request.limits.maxMemoryBytes / 16))))
  runtime.setInterruptHandler(() => cancelled || Date.now() >= deadline)
  const context = runtime.newContext()
  const ownedHandles = []
  const capabilityEvents = []
  const observedCapabilities = new Set()
  let terminal
  let terminalValue
  let runtimeError
  let readBytes = 0
  try {
    const toolHandle = context.newObject()
    const readFileFn = context.newFunction('readFile', (pathHandle) => {
      const path = String(context.dump(pathHandle))
      const content = request.files[path]
      const allowed = typeof content === 'string'
      capabilityEvents.push({
        sequence: capabilityEvents.length + 1,
        capability: 'filesystem.read',
        decision: allowed ? 'allowed' : 'denied',
        resourceHash: resourceHash(path),
        ...(allowed ? {} : { reason: 'undeclared-file' })
      })
      observedCapabilities.add('filesystem.read')
      if (!allowed) throw structuredRuntimeError('generated-tool-filesystem-undeclared-file', 'Generated Tool attempted to read an undeclared file', { path })
      const contentBytes = Buffer.byteLength(content, 'utf8')
      if (readBytes + contentBytes > request.readBudgetBytes) {
        capabilityEvents[capabilityEvents.length - 1] = {
          ...capabilityEvents[capabilityEvents.length - 1],
          decision: 'denied',
          reason: 'read-budget-exceeded'
        }
        throw structuredRuntimeError('generated-tool-filesystem-read-budget-exceeded', 'Generated Tool cumulative file-read budget exceeded', {
          path,
          limit: request.readBudgetBytes,
          actual: readBytes + contentBytes
        })
      }
      readBytes += contentBytes
      return context.newString(content)
    })
    const complete = (kind, valueHandle) => {
      if (terminal) throw new Error('Generated Tool emitted multiple terminal results')
      const value = context.dump(valueHandle)
      const bytes = serializedBytes(value)
      if (bytes > request.limits.maxOutputBytes) throw new Error('DENIED: output exceeds manifest limit')
      terminal = kind
      terminalValue = value
    }
    const outputFn = context.newFunction('output', (valueHandle) => complete('output', valueHandle))
    const failFn = context.newFunction('fail', (valueHandle) => complete('fail', valueHandle))
    context.setProp(toolHandle, 'readFile', readFileFn)
    context.setProp(toolHandle, 'output', outputFn)
    context.setProp(toolHandle, 'fail', failFn)
    context.setProp(context.global, 'tool', toolHandle)
    ownedHandles.push(toolHandle, readFileFn, outputFn, failFn)

    const inputHandle = context.newString(JSON.stringify(request.input))
    const parseHandle = context.getProp(context.global, 'JSON')
    const parseFn = context.getProp(parseHandle, 'parse')
    const parsedInput = context.callFunction(parseFn, parseHandle, inputHandle)
    inputHandle.dispose()
    parseFn.dispose()
    parseHandle.dispose()
    if (parsedInput.error) {
      const dumped = context.dump(parsedInput.error)
      parsedInput.error.dispose()
      throw new Error(dumped?.message ?? String(dumped))
    }
    context.setProp(context.global, 'input', parsedInput.value)
    parsedInput.value.dispose()

    const evaluation = context.evalCode(request.source, request.entrypoint)
    if (evaluation.error) {
      const dumped = context.dump(evaluation.error)
      evaluation.error.dispose()
      runtimeError = dumped && typeof dumped === 'object' && dumped.message !== undefined
        ? String(dumped.message)
        : String(dumped)
    } else {
      evaluation.value.dispose()
    }
  } catch (caught) {
    runtimeError = runtimeErrorMessage(caught)
  } finally {
    for (const handle of ownedHandles) {
      try { handle.dispose() } catch { /* disposed by runtime teardown */ }
    }
    try { context.dispose() } finally { runtime.dispose() }
  }

  let outcome
  let output
  let error
  if (cancelled) {
    outcome = 'cancelled'
    error = 'cancelled'
  } else if (Date.now() >= deadline && /interrupted|InternalError/i.test(runtimeError ?? '')) {
    outcome = 'timed-out'
    error = 'timed-out'
  } else if (runtimeError) {
    outcome = 'runtime-failed'
    error = parseRuntimeError(runtimeError)
  } else if (terminal === 'output') {
    outcome = 'succeeded'
    output = terminalValue
  } else if (terminal === 'fail') {
    outcome = 'tool-failed'
    error = terminalValue
  } else {
    outcome = 'runtime-failed'
    error = 'missing-terminal-result'
  }
  return {
    outcome,
    ok: outcome === 'succeeded',
    output,
    error,
    observedCapabilities: [...observedCapabilities],
    capabilityEvents,
    inputBytes: Buffer.byteLength(JSON.stringify(request.input), 'utf8'),
    outputBytes: serializedBytes(output ?? error),
    readBytes,
    durationMs: Date.now() - startedAt,
    terminatedByBudget: outcome === 'timed-out' || outcome === 'cancelled'
  }
}
