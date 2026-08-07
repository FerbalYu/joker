import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { GeneratedToolManifest } from '../../../shared/generated-tools'
import { GENERATED_TOOL_FILESYSTEM_QUOTAS, runGeneratedTool } from './runner'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'joker-generated-runner-'))
  const workspacePath = join(root, 'workspace')
  mkdirSync(join(workspacePath, 'fixtures'), { recursive: true })
  writeFileSync(join(workspacePath, 'fixtures', 'tasks.json'), '[{"status":"open"}]', 'utf8')
  writeFileSync(join(workspacePath, 'fixtures', 'undeclared.txt'), 'secret', 'utf8')
  writeFileSync(join(root, 'outside.txt'), 'outside', 'utf8')
  const manifest: GeneratedToolManifest = {
    schemaVersion: 1,
    toolId: 'runner-fixture',
    displayName: 'RunnerFixture',
    description: 'Runner test fixture.',
    sdkVersion: '1.0.0',
    runtime: { id: 'quickjs-wasm', version: '0.32.0' },
    entrypoint: 'source/tool.js',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'string' },
    errorContract: { type: 'object' },
    permissions: {
      filesystem: { read: ['fixtures/tasks.json'], write: [] },
      network: { hosts: [], methods: [] },
      process: { commands: [] },
      environment: { keys: [] },
      secrets: { handles: [] }
    },
    dependencies: [],
    limits: { timeoutMs: 2_000, maxInputBytes: 1_024, maxOutputBytes: 4_096, maxMemoryBytes: 32_000_000 }
  }
  return { root, workspacePath, manifest }
}

void test('project-read runner executes in an isolated worker with declared files only', async () => {
  const { root, workspacePath, manifest } = fixture()
  try {
    const result = await runGeneratedTool({
      manifest,
      workspacePath,
      input: {},
      source: 'tool.output(JSON.parse(tool.readFile("fixtures/tasks.json"))[0].status)'
    })
    assert.equal(result.outcome, 'succeeded')
    assert.equal(result.ok, true)
    assert.equal(result.output, 'open')
    assert.equal(result.terminatedByBudget, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

void test('project-read runner denies undeclared workspace files and outside paths', async () => {
  const { root, workspacePath, manifest } = fixture()
  try {
    for (const path of ['fixtures/undeclared.txt', '../outside.txt']) {
      const result = await runGeneratedTool({
        manifest,
        workspacePath,
        input: {},
        source: `tool.output(tool.readFile(${JSON.stringify(path)}))`
      })
      assert.equal(result.ok, false)
      assert.deepEqual(result.error, {
        code: 'generated-tool-filesystem-undeclared-file',
        message: 'Generated Tool attempted to read an undeclared file',
        path
      })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

void test('project-read runner denies declared symlink escapes', async (t) => {
  const { root, workspacePath, manifest } = fixture()
  try {
    const linkPath = join(workspacePath, 'fixtures', 'linked-outside.txt')
    try {
      symlinkSync(join(root, 'outside.txt'), linkPath, 'file')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES') {
        t.skip(`symlink creation unavailable: ${code}`)
        return
      }
      throw error
    }
    const result = await runGeneratedTool({
      manifest: {
        ...manifest,
        permissions: {
          ...manifest.permissions,
          filesystem: { read: ['fixtures/linked-outside.txt'], write: [] }
        }
      },
      workspacePath,
      input: {},
      source: 'tool.output(tool.readFile("fixtures/linked-outside.txt"))'
    })
    assert.equal(result.outcome, 'runtime-failed')
    assert.deepEqual(result.error, {
      code: 'generated-tool-filesystem-invalid-file',
      message: 'Declared file must not be a symbolic link',
      path: 'fixtures/linked-outside.txt'
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

void test('runner enforces declared-file count and per-file preload boundaries', async () => {
  const { root, workspacePath, manifest } = fixture()
  try {
    const exactPath = join(workspacePath, 'fixtures', 'exact.txt')
    writeFileSync(exactPath, Buffer.alloc(GENERATED_TOOL_FILESYSTEM_QUOTAS.maxFileBytes, 0x61))
    const exact = await runGeneratedTool({
      manifest: {
        ...manifest,
        permissions: { ...manifest.permissions, filesystem: { read: ['fixtures/exact.txt'], write: [] } }
      },
      workspacePath,
      input: {},
      source: 'tool.output(tool.readFile("fixtures/exact.txt").length)'
    })
    assert.equal(exact.outcome, 'succeeded')
    assert.equal(exact.output, GENERATED_TOOL_FILESYSTEM_QUOTAS.maxFileBytes)

    const oversizedPath = join(workspacePath, 'fixtures', 'oversized.txt')
    writeFileSync(oversizedPath, Buffer.alloc(GENERATED_TOOL_FILESYSTEM_QUOTAS.maxFileBytes + 1, 0x62))
    const oversized = await runGeneratedTool({
      manifest: {
        ...manifest,
        permissions: { ...manifest.permissions, filesystem: { read: ['fixtures/oversized.txt'], write: [] } }
      },
      workspacePath,
      input: {},
      source: 'tool.output("unreachable")'
    })
    assert.equal(oversized.outcome, 'runtime-failed')
    assert.equal((oversized.error as { code?: string }).code, 'generated-tool-filesystem-file-bytes-exceeded')

    const declared: string[] = []
    for (let index = 0; index <= GENERATED_TOOL_FILESYSTEM_QUOTAS.maxDeclaredFiles; index += 1) {
      const path = `fixtures/count-${index}.txt`
      writeFileSync(join(workspacePath, path), '')
      declared.push(path)
    }
    const tooMany = await runGeneratedTool({
      manifest: {
        ...manifest,
        permissions: { ...manifest.permissions, filesystem: { read: declared, write: [] } }
      },
      workspacePath,
      input: {},
      source: 'tool.output("unreachable")'
    })
    assert.equal(tooMany.outcome, 'runtime-failed')
    assert.deepEqual(tooMany.error, {
      code: 'generated-tool-filesystem-file-count-exceeded',
      message: 'Generated Tool declares too many readable files',
      limit: GENERATED_TOOL_FILESYSTEM_QUOTAS.maxDeclaredFiles,
      actual: GENERATED_TOOL_FILESYSTEM_QUOTAS.maxDeclaredFiles + 1
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

void test('runner enforces aggregate preload and cumulative repeated-read budgets', async () => {
  const { root, workspacePath, manifest } = fixture()
  try {
    const chunkBytes = GENERATED_TOOL_FILESYSTEM_QUOTAS.maxFileBytes
    const exactPaths: string[] = []
    for (let index = 0; index < GENERATED_TOOL_FILESYSTEM_QUOTAS.maxPreloadBytes / chunkBytes; index += 1) {
      const path = `fixtures/aggregate-${index}.txt`
      writeFileSync(join(workspacePath, path), Buffer.alloc(chunkBytes, 0x63))
      exactPaths.push(path)
    }
    const exact = await runGeneratedTool({
      manifest: {
        ...manifest,
        permissions: { ...manifest.permissions, filesystem: { read: exactPaths, write: [] } }
      },
      workspacePath,
      input: {},
      source: 'tool.output("loaded")'
    })
    assert.equal(exact.outcome, 'succeeded')

    const overflowPath = 'fixtures/aggregate-overflow.txt'
    writeFileSync(join(workspacePath, overflowPath), 'x')
    const aggregateOverflow = await runGeneratedTool({
      manifest: {
        ...manifest,
        permissions: { ...manifest.permissions, filesystem: { read: [...exactPaths, overflowPath], write: [] } }
      },
      workspacePath,
      input: {},
      source: 'tool.output("unreachable")'
    })
    assert.equal(aggregateOverflow.outcome, 'runtime-failed')
    assert.equal((aggregateOverflow.error as { code?: string }).code, 'generated-tool-filesystem-preload-bytes-exceeded')

    const repeatedPath = 'fixtures/repeated.txt'
    const repeatedBytes = GENERATED_TOOL_FILESYSTEM_QUOTAS.maxFileBytes
    writeFileSync(join(workspacePath, repeatedPath), Buffer.alloc(repeatedBytes, 0x64))
    const repeated = await runGeneratedTool({
      manifest: {
        ...manifest,
        permissions: { ...manifest.permissions, filesystem: { read: [repeatedPath], write: [] } }
      },
      workspacePath,
      input: {},
      source: `tool.readFile(${JSON.stringify(repeatedPath)}); tool.readFile(${JSON.stringify(repeatedPath)}); tool.readFile(${JSON.stringify(repeatedPath)}); tool.readFile(${JSON.stringify(repeatedPath)}); tool.output(tool.readFile(${JSON.stringify(repeatedPath)}))`
    })
    assert.equal(repeated.outcome, 'runtime-failed')
    assert.deepEqual(repeated.error, {
      code: 'generated-tool-filesystem-read-budget-exceeded',
      message: 'Generated Tool cumulative file-read budget exceeded',
      path: repeatedPath,
      limit: GENERATED_TOOL_FILESYSTEM_QUOTAS.maxReadBytes,
      actual: repeatedBytes * 5
    })
    assert.equal(repeated.readBytes, repeatedBytes * 4)
    assert.equal(repeated.capabilityEvents.at(-1)?.reason, 'read-budget-exceeded')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

void test('runner quota failures release file handles so fixtures can be removed', async () => {
  const { root, workspacePath, manifest } = fixture()
  const path = join(workspacePath, 'fixtures', 'cleanup.txt')
  writeFileSync(path, Buffer.alloc(GENERATED_TOOL_FILESYSTEM_QUOTAS.maxFileBytes + 1, 0x65))
  const result = await runGeneratedTool({
    manifest: {
      ...manifest,
      permissions: { ...manifest.permissions, filesystem: { read: ['fixtures/cleanup.txt'], write: [] } }
    },
    workspacePath,
    input: {},
    source: 'tool.output("unreachable")'
  })
  assert.equal((result.error as { code?: string }).code, 'generated-tool-filesystem-file-bytes-exceeded')
  assert.doesNotThrow(() => rmSync(root, { recursive: true, force: false }))
})

void test('project-read runner exposes no host process and interrupts infinite loops', async () => {
  const { root, workspacePath, manifest } = fixture()
  try {
    const noHost = await runGeneratedTool({
      manifest,
      workspacePath,
      input: {},
      source: 'tool.output(typeof process)'
    })
    assert.equal(noHost.output, 'undefined')
    const timed = await runGeneratedTool({
      manifest: { ...manifest, limits: { ...manifest.limits, timeoutMs: 50 } },
      workspacePath,
      input: {},
      source: 'while (true) {}'
    })
    assert.equal(timed.ok, false)
    assert.equal(timed.terminatedByBudget, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

void test('project-read runner supports real in-flight cancellation', async () => {
  const { root, workspacePath, manifest } = fixture()
  try {
    const controller = new AbortController()
    const pending = runGeneratedTool({ manifest, workspacePath, input: {}, source: 'while (true) {}', signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    const result = await pending
    assert.equal(result.ok, false)
    assert.equal(result.terminatedByBudget, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

void test('runner distinguishes explicit tool failure and missing terminal output', async () => {
  const { root, workspacePath, manifest } = fixture()
  try {
    const failed = await runGeneratedTool({
      manifest,
      workspacePath,
      input: {},
      source: 'tool.fail({ code: "fixture-failure" })'
    })
    assert.equal(failed.outcome, 'tool-failed')
    assert.deepEqual(failed.error, { code: 'fixture-failure' })
    const missing = await runGeneratedTool({ manifest, workspacePath, input: {}, source: 'const value = 1' })
    assert.equal(missing.outcome, 'runtime-failed')
    assert.equal(missing.error, 'missing-terminal-result')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

void test('runner records denied capability attempts even when source catches them', async () => {
  const { root, workspacePath, manifest } = fixture()
  try {
    const result = await runGeneratedTool({
      manifest,
      workspacePath,
      input: {},
      source: 'try { tool.readFile("fixtures/undeclared.txt") } catch (_) {} tool.output("looks-ok")'
    })
    assert.equal(result.outcome, 'succeeded')
    assert.equal(result.output, 'looks-ok')
    assert.equal(result.capabilityEvents.some((event) => event.decision === 'denied'), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

void test('project-read runner rejects unsupported permissions and resource overflow', async () => {
  const { root, workspacePath, manifest } = fixture()
  try {
    const network = await runGeneratedTool({
      manifest: { ...manifest, permissions: { ...manifest.permissions, network: { hosts: ['example.com'], methods: ['GET'] } } },
      workspacePath,
      input: {},
      source: 'tool.output("x")'
    })
    assert.equal(network.ok, false)
    assert.match(String(network.error ?? ''), /unsupported/)

    const incompatible = await runGeneratedTool({
      manifest: { ...manifest, sdkVersion: '2.0.0' },
      workspacePath,
      input: {},
      source: 'tool.output("x")'
    })
    assert.equal(incompatible.ok, false)
    assert.deepEqual(incompatible.error, {
      code: 'generated-tool-incompatible',
      reasons: [{
        code: 'unsupported-sdk-version',
        field: 'sdkVersion',
        expected: ['1.0.0', '1'],
        actual: '2.0.0'
      }]
    })

    const oversized = await runGeneratedTool({
      manifest: { ...manifest, limits: { ...manifest.limits, maxInputBytes: 1 } },
      workspacePath,
      input: { value: 'too large' },
      source: 'tool.output("x")'
    })
    assert.equal(oversized.ok, false)
    assert.match(String(oversized.error ?? ''), /input exceeds/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
