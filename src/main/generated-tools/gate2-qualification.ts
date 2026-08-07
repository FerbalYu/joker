import type { ForgeJob, GeneratedToolManifest } from '../../shared/generated-tools'
import { sealGeneratedToolCandidate } from './candidate-store'
import type { ForgeServiceMaker } from './forge-service'
import { readForgeJob } from './forge-job-store'
import { ForgeWorkspaceBroker } from './forge-workspace'

export type Gate2QualificationScenario = 'success' | 'explicit-failure' | 'fake-success' | 'overreach'

export const GATE2_QUALIFICATION_TOOL_ID = 'gate2-qualification-tool'

export const GATE2_QUALIFICATION_MANIFEST: GeneratedToolManifest = {
  schemaVersion: 1,
  toolId: GATE2_QUALIFICATION_TOOL_ID,
  displayName: 'Gate2QualificationTool',
  description: 'Deterministic Gate 2 manufacturing and validator qualification fixture.',
  sdkVersion: '1.0.0',
  runtime: { id: 'quickjs-wasm', version: '0.32.0' },
  entrypoint: 'dist/tool.js',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'string' },
  errorContract: {
    type: 'object',
    properties: { message: { type: 'string' } },
    required: ['message'],
    additionalProperties: false
  },
  permissions: {
    filesystem: { read: [], write: [] },
    network: { hosts: [] },
    process: { commands: [] },
    environment: { keys: [] },
    secrets: { handles: [] }
  },
  dependencies: [],
  limits: { timeoutMs: 500, maxInputBytes: 1024, maxOutputBytes: 4096, maxMemoryBytes: 32_000_000 }
}

export function gate2QualificationSpec(requestedBy: ForgeJob['spec']['requestedBy']): ForgeJob['spec'] {
  return {
    id: GATE2_QUALIFICATION_TOOL_ID,
    displayName: GATE2_QUALIFICATION_MANIFEST.displayName,
    goal: 'Return ok for normal input and an explicit structured failure when input.fail is true.',
    reason: 'Gate 2 qualification requires a deterministic missing capability.',
    requestedBy,
    scope: 'project',
    projectId: 'gate2-qualification-project',
    inputContract: GATE2_QUALIFICATION_MANIFEST.inputSchema,
    outputContract: GATE2_QUALIFICATION_MANIFEST.outputSchema,
    permissions: GATE2_QUALIFICATION_MANIFEST.permissions,
    acceptance: ['Normal input returns ok.', 'Failure input uses tool.fail with expected-failure.'],
    examples: [{ input: {}, expected: 'ok' }, { input: { fail: true }, expected: 'expected-failure' }]
  }
}

export function gate2QualificationSource(scenario: Gate2QualificationScenario): string {
  if (scenario === 'fake-success') return 'if (input.fail) tool.output("ERROR: expected-failure"); else tool.output("ok")'
  if (scenario === 'overreach') return 'try { tool.readFile("undeclared.txt") } catch (_) {} if (input.fail) tool.fail({message:"expected-failure"}); else tool.output("ok")'
  return 'if (input.fail) tool.fail({message:"expected-failure"}); else tool.output("ok")'
}

export function createGate2QualificationMaker(scenario: Gate2QualificationScenario): ForgeServiceMaker {
  return async (input) => {
    const broker = new ForgeWorkspaceBroker(input.jokerHome, input.job.id)
    const source = gate2QualificationSource(scenario)
    broker.writeFile('manifest.json', `${JSON.stringify(GATE2_QUALIFICATION_MANIFEST, null, 2)}\n`)
    broker.writeFile('source/tool.js', source)
    broker.writeFile('dist/tool.js', source)
    const checked = broker.runCheck()
    if (checked.status !== 'passed') throw new Error(checked.message)
    if (input.toolContext.abortSignal?.aborted) throw input.toolContext.abortSignal.reason
    const latest = readForgeJob(input.jokerHome, input.job.id)
    if (!latest) throw new Error(`ForgeJob not found: ${input.job.id}`)
    const sealed = sealGeneratedToolCandidate({
      jokerHome: input.jokerHome,
      jobId: input.job.id,
      expectedRevision: latest.revision,
      validationSuiteId: input.validationSuiteId,
      validationSuiteHash: input.validationSuiteHash,
      createdAt: (input.now ?? Date.now)(),
      validationRunId: (input.createValidationRunId ?? (() => `validation-${input.job.id}-${input.job.attempt}`))()
    })
    return {
      output: JSON.stringify({ candidateId: sealed.candidate.id, trusted: false, registered: false, active: false }),
      usage: undefined,
      steps: 4
    } as never
  }
}
