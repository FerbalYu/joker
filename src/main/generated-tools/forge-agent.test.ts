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
