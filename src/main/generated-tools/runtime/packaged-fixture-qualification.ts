import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { buildGeneratedToolDefinitions, listGeneratedToolSnapshotBindings } from '../adapter'
import { installSummarizeTaskJsonFixture } from '../fixture'
import { installRuntimeQualificationFixture } from '../test-fixtures'
import { readGeneratedToolInvocations } from '../invocation-store'
import { readGeneratedToolRegistry } from '../registry'
import { buildToolSet } from '../../tools/registry'

export async function runPackagedGeneratedToolFixtureQualification(): Promise<boolean> {
  if (process.env['JOKER_PACKAGED_TOOLFORGE_FIXTURE_QUALIFICATION'] !== '1') return false
  const jokerHome = process.env['JOKER_HOME']?.trim()
  const workspace = process.env['JOKER_PACKAGED_TOOLFORGE_FIXTURE_WORKSPACE']?.trim()
  const fixtureRoot = process.env['JOKER_PACKAGED_TOOLFORGE_FIXTURE_ROOT']?.trim()
  const reportPath = process.env['JOKER_PACKAGED_TOOLFORGE_FIXTURE_REPORT']?.trim()
  const runId = process.env['JOKER_PACKAGED_TOOLFORGE_FIXTURE_RUN_ID']?.trim()
  if (!jokerHome || !workspace || !fixtureRoot || !reportPath || !runId) {
    throw new Error('Packaged Generated Tool fixture qualification environment is incomplete')
  }

  const report = await executePackagedQualification(jokerHome, workspace, fixtureRoot, runId)
  mkdirSync(dirname(resolve(reportPath)), { recursive: true })
  writeFileSync(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return true
}

async function executePackagedQualification(
  jokerHome: string,
  workspace: string,
  fixtureRoot: string,
  runId: string
): Promise<Record<string, unknown>> {
  const qualificationHome = process.env['JOKER_PACKAGED_TOOLFORGE_FIXTURE_QUALIFICATION_HOME']?.trim()
  if (qualificationHome) {
    const source = join(resolve(qualificationHome), '.joker', 'qualification')
    const target = join(resolve(jokerHome), '.joker', 'qualification')
    mkdirSync(dirname(target), { recursive: true })
    cpSync(source, target, { recursive: true, force: true })
  } else {
    installRuntimeQualificationFixture(jokerHome)
  }
  const version = installSummarizeTaskJsonFixture(jokerHome, Date.now(), { fixtureRoot })
  const bindings = listGeneratedToolSnapshotBindings({ jokerHome, projectId: 'qualification-p0' })
  const definitions = buildGeneratedToolDefinitions(workspace, jokerHome, bindings, new Set(), 'qualification-p0')
  if (definitions.length !== 1) throw new Error('Packaged fixture qualification did not discover exactly one Generated Tool')
  const toolSet = buildToolSet(definitions, {
    workspacePath: workspace,
    sessionId: `fixture-session-${runId}`,
    runId,
    approvalGate: async () => ({ outcome: 'allow', risk: 'read', reason: 'packaged fixture qualification' })
  })
  const output = await (toolSet['summarize-task-json'] as unknown as {
    execute: (input: Record<string, unknown>, options: { toolCallId: string }) => Promise<{ output: string }>
  }).execute({}, { toolCallId: `fixture-call-${runId}` })
  const invocations = readGeneratedToolInvocations(jokerHome).invocations
  const invocation = invocations.find((item) => item.runId === runId)
  if (!invocation || invocation.status !== 'finished' || invocation.outcome !== 'succeeded' || !invocation.outputHash) {
    throw new Error('Packaged fixture qualification invocation did not reach a successful durable terminal state')
  }
  const registry = readGeneratedToolRegistry(jokerHome)
  const tasks = JSON.parse(readFileSync(resolve(workspace, 'fixtures', 'tasks.json'), 'utf8')) as unknown[]
  return {
    schemaVersion: 1,
    status: 'pass',
    runId,
    output: output.output,
    taskCount: tasks.length,
    versionId: version.id,
    registryRevision: registry.revision,
    capabilityRevision: registry.capabilityRevision.revision,
    invocation: {
      id: invocation.id,
      status: invocation.status,
      outcome: invocation.outcome,
      outputHash: invocation.outputHash,
      toolCallId: invocation.toolCallId,
      versionId: invocation.versionId,
      capabilityRevision: invocation.capabilityRevision
    },
    invocationCount: invocations.length
  }
}
