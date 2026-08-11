import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { GeneratedToolManifest } from '../../../shared/generated-tools'
import { runUserOwnedFullTrustTool } from './user-owned-full-trust-runner'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'joker-full-trust-runner-'))
  const workspacePath = join(root, 'workspace')
  mkdirSync(workspacePath, { recursive: true })
  const manifest: GeneratedToolManifest = {
    schemaVersion: 1,
    toolId: 'full-trust-runner-fixture',
    displayName: 'FullTrustRunnerFixture',
    description: 'Full-trust runner test fixture.',
    sdkVersion: '1.0.0',
    runtime: { id: 'node-child-process', version: '1' },
    entrypoint: 'source/tool.js',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    errorContract: { type: 'object' },
    permissions: {
      filesystem: { read: [], write: [] },
      network: { hosts: [], methods: [] },
      process: { commands: [] },
      environment: { keys: [] },
      secrets: { handles: [] }
    },
    dependencies: [],
    limits: { timeoutMs: 10, maxInputBytes: 1, maxOutputBytes: 1, maxMemoryBytes: 1_000_000 }
  }
  return { root, workspacePath, manifest }
}

void test('full-trust runner ignores declared capability and resource limits', async () => {
  const { root, workspacePath, manifest } = fixture()
  try {
    const result = await runUserOwnedFullTrustTool({
      manifest,
      workspacePath,
      input: { payload: 'far beyond the declared one-byte limit' },
      environment: { UNDECLARED_VALUE: 'visible' },
      source: 'tool.writeFile("../outside.txt", tool.readEnvironment("UNDECLARED_VALUE")); tool.output(tool.readFile("../outside.txt"))'
    })
    assert.equal(result.outcome, 'succeeded', JSON.stringify(result.error))
    assert.equal(result.output, 'visible')
    assert.equal(readFileSync(join(root, 'outside.txt'), 'utf8'), 'visible')
    assert.ok(result.capabilityEvents.every((event) => event.decision === 'allowed'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

void test('full-trust runner honors a generated tool process options', async () => {
  const { root, workspacePath, manifest } = fixture()
  try {
    const result = await runUserOwnedFullTrustTool({
      manifest,
      workspacePath,
      input: { root },
      source: 'const result = await tool.run(process.execPath, ["-e", "process.stdout.write(process.cwd())"], { cwd: input.root }); tool.output(result.stdout)'
    })
    assert.equal(result.outcome, 'succeeded', JSON.stringify(result.error))
    assert.equal(result.output, root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

void test('full-trust runner accepts ordinary CommonJS Node tool modules', async () => {
  const { root, workspacePath, manifest } = fixture()
  try {
    const result = await runUserOwnedFullTrustTool({
      manifest,
      workspacePath,
      input: { value: 'stored' },
      source: 'const fs = require("node:fs"); module.exports.handle = (input) => { fs.writeFileSync("../raw-node.txt", input.value); return { value: fs.readFileSync("../raw-node.txt", "utf8") } }'
    })
    assert.equal(result.outcome, 'succeeded', JSON.stringify(result.error))
    assert.deepEqual(result.output, { value: 'stored' })
    assert.equal(readFileSync(join(root, 'raw-node.txt'), 'utf8'), 'stored')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

void test('full-trust runner accepts a Node entrypoint shebang', async () => {
  const { root, workspacePath, manifest } = fixture()
  try {
    const result = await runUserOwnedFullTrustTool({
      manifest,
      workspacePath,
      input: { value: 'stored' },
      source: '#!/usr/bin/env node\nmodule.exports.handle = (input) => ({ value: input.value })'
    })
    assert.equal(result.outcome, 'succeeded', JSON.stringify(result.error))
    assert.deepEqual(result.output, { value: 'stored' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

void test('full-trust runner resolves CommonJS dependencies relative to the generated entrypoint', async () => {
  const { root, workspacePath, manifest } = fixture()
  try {
    const entrypointPath = join(root, 'generated', 'dist', 'index.js')
    const dependencyPath = join(root, 'generated', 'dist', 'dependency.js')
    mkdirSync(join(root, 'generated', 'dist'), { recursive: true })
    writeFileSync(dependencyPath, 'module.exports = { value: "resolved-from-entrypoint" }\n')
    const result = await runUserOwnedFullTrustTool({
      manifest,
      workspacePath,
      entrypointPath,
      input: {},
      source: 'module.exports.handle = () => require("./dependency.js")'
    })
    assert.equal(result.outcome, 'succeeded', JSON.stringify(result.error))
    assert.deepEqual(result.output, { value: 'resolved-from-entrypoint' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

void test('full-trust runner keeps generated .js modules CommonJS under a type=module parent package', async () => {
  const { root, workspacePath, manifest } = fixture()
  try {
    const generatedRoot = join(root, 'generated')
    const entrypointPath = join(generatedRoot, 'dist', 'index.js')
    const sourcePath = join(generatedRoot, 'source', 'index.js')
    mkdirSync(join(generatedRoot, 'dist'), { recursive: true })
    mkdirSync(join(generatedRoot, 'source'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
    writeFileSync(join(generatedRoot, 'manifest.json'), '{}')
    writeFileSync(sourcePath, 'const path = require("node:path"); module.exports.handle = (input) => ({ value: path.basename(input.value) })')

    const result = await runUserOwnedFullTrustTool({
      manifest,
      workspacePath,
      entrypointPath,
      input: { value: 'nested/example.txt' },
      source: 'module.exports = require("../source/index.js")'
    })

    assert.equal(result.outcome, 'succeeded', JSON.stringify(result.error))
    assert.deepEqual(result.output, { value: 'example.txt' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

void test('full-trust runner accepts common generated entrypoint export names', async () => {
  for (const name of ['execute', 'main', 'run', 'default']) {
    const { root, workspacePath, manifest } = fixture()
    try {
      const result = await runUserOwnedFullTrustTool({
        manifest,
        workspacePath,
        input: { name },
        source: `module.exports.${name} = (input) => ({ called: input.name })`
      })
      assert.equal(result.outcome, 'succeeded', `${name}: ${JSON.stringify(result.error)}`)
      assert.deepEqual(result.output, { called: name })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})
