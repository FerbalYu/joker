import { createHash } from 'node:crypto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ForgeJob } from '../../shared/generated-tools'
import { canonicalGeneratedToolJson } from '../../shared/generated-tools-schema'
import { runForgeAgent } from './forge-agent'
import { createForgeJob, updateForgeJob } from './forge-job-store'
import { getForgeAgentToolNames } from './forge-tools'

function fullTrustSpec(): ForgeJob['spec'] {
  return {
    id: 'forge-agent-full-trust-tool', displayName: 'ForgeAgentFullTrustTool', goal: 'Persist memory', reason: 'Capability missing',
    requestedBy: { sessionId: 'session-1', runId: 'run-1', userMessageId: 'message-1' }, scope: 'project', projectId: 'project-1',
    inputContract: {}, outputContract: { type: 'object' },
    permissions: { filesystem: { read: [], write: ['.project-memory/MEMORY.md'] }, network: { hosts: [] }, process: { commands: [] }, environment: { keys: [] }, secrets: { handles: [] } },
    validationProfile: 'user-owned-full-trust-v1',
    validationCases: [
      { id: 'success', input: {}, workspaceFiles: {}, expected: { outcome: 'succeeded', output: { saved: true } } },
      { id: 'failure', input: { fail: true }, workspaceFiles: {}, expected: { outcome: 'tool-failed', error: { message: 'expected-failure' } } }
    ],
    acceptance: ['Writes only the declared memory file.'], examples: [{ input: {}, expected: 'legacy' }]
  }
}

void test('dedicated ForgeAgent exposes only Forge tools to its model run', async () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-forge-agent-'))
  try {
    const spec: ForgeJob['spec'] = {
      id: 'forge-agent-tool', displayName: 'ForgeAgentTool', goal: 'Return ok', reason: 'Capability missing',
      requestedBy: { sessionId: 'session-1', runId: 'run-1', userMessageId: 'message-1' }, scope: 'project', projectId: 'project-1',
      inputContract: {}, outputContract: { type: 'string' },
      permissions: { filesystem: { read: [], write: [] }, network: { hosts: [] }, process: { commands: [] }, environment: { keys: [] }, secrets: { handles: [] } },
      acceptance: ['Returns ok.'], examples: [{ input: {}, expected: 'ok' }]
    }
    const job: ForgeJob = {
      id: 'job-forge-agent', idempotencyKey: 'idem-forge-agent',
      specHash: createHash('sha256').update(canonicalGeneratedToolJson(spec)).digest('hex'),
      toolId: spec.id, mode: 'create', status: 'queued', revision: 0, spec, attempt: 1, maxAttempts: 3,
      createdAt: 1, updatedAt: 1, artifactPath: 'jobs/job-forge-agent/workspace'
    }
    createForgeJob(home, job)
    updateForgeJob(home, job.id, 0, (current) => ({ ...current, revision: 1, status: 'planning', startedAt: 2, updatedAt: 2 }))
    updateForgeJob(home, job.id, 1, (current) => ({ ...current, revision: 2, status: 'building', updatedAt: 3 }))

    let exposedTools: string[] = []
    let systemText = ''
    const model = {
      specificationVersion: 'v2', provider: 'test', modelId: 'forge-test', defaultObjectGenerationMode: 'json',
      doGenerate: async () => { throw new Error('unused') },
      doStream: async (options: { tools?: Array<{ name?: string }>; prompt?: Array<{ role?: string; content?: string }> }) => {
        exposedTools = (options.tools ?? []).map((tool) => tool.name ?? '').filter(Boolean)
        systemText = (options.prompt ?? []).filter((message) => message.role === 'system').map((message) => message.content ?? '').join('\n')
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'text-start', id: 'text-1' })
              controller.enqueue({ type: 'text-delta', id: 'text-1', delta: 'done' })
              controller.enqueue({ type: 'text-end', id: 'text-1' })
              controller.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } })
              controller.close()
            }
          }),
          rawCall: { rawPrompt: null, rawSettings: {} }
        }
      }
    } as unknown as Parameters<typeof runForgeAgent>[0]['model']
    const result = await runForgeAgent({
      jokerHome: home,
      jobId: job.id,
      validationSuiteId: 'forge-agent-v1',
      validationSuiteHash: 'a'.repeat(64),
      prompt: 'Build the candidate.',
      model,
      toolContext: {
        workspacePath: 'C:\\ambient-workspace',
        sessionId: 'session-1',
        runId: 'run-1',
        approvalGate: async () => ({ outcome: 'deny', risk: 'external', reason: 'ambient gate must not be used' })
      }
    })
    assert.equal(result.output, 'done')
    assert.deepEqual(exposedTools.sort(), getForgeAgentToolNames().sort())
    assert.match(systemText, /no Bash, Git, network, MCP/)
    assert.match(systemText, /immutable untrusted candidate only/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('dedicated ForgeAgent receives the sealed full-trust runtime instruction', async () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-forge-agent-full-trust-'))
  try {
    const spec = fullTrustSpec()
    const job: ForgeJob = {
      id: 'job-forge-agent-full-trust', idempotencyKey: 'idem-forge-agent-full-trust',
      specHash: createHash('sha256').update(canonicalGeneratedToolJson(spec)).digest('hex'),
      toolId: spec.id, mode: 'create', status: 'building', revision: 2, spec, attempt: 1, maxAttempts: 3,
      createdAt: 1, updatedAt: 1, artifactPath: 'jobs/job-forge-agent-full-trust/workspace'
    }
    createForgeJob(home, job)
    let systemText = ''
    const model = {
      specificationVersion: 'v2', provider: 'test', modelId: 'forge-full-trust-test', defaultObjectGenerationMode: 'json',
      doGenerate: async () => { throw new Error('unused') },
      doStream: async (options: { prompt?: Array<{ role?: string; content?: string }> }) => {
        systemText = (options.prompt ?? []).filter((message) => message.role === 'system').map((message) => message.content ?? '').join('\n')
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'text-start', id: 'text-1' })
              controller.enqueue({ type: 'text-delta', id: 'text-1', delta: 'done' })
              controller.enqueue({ type: 'text-end', id: 'text-1' })
              controller.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } })
              controller.close()
            }
          }),
          rawCall: { rawPrompt: null, rawSettings: {} }
        }
      }
    } as unknown as Parameters<typeof runForgeAgent>[0]['model']
    await runForgeAgent({
      jokerHome: home, jobId: job.id, prompt: 'Build the candidate.', model,
      toolContext: { workspacePath: null, sessionId: 'session-1', runId: 'run-1', approvalGate: async () => ({ outcome: 'allow', risk: 'write_local', reason: 'test' }) }
    })
    assert.match(systemText, /node-child-process Generated Tool \(runtime version 1\)/)
    assert.match(systemText, /provided tool capability SDK rather than direct host APIs/)
    assert.doesNotMatch(systemText, /only an ES2020 quickjs-wasm/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
