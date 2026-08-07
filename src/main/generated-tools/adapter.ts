import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { z } from 'zod'

import type {
  GeneratedToolDescriptor,
  GeneratedToolRegistryState,
  GeneratedToolVersion,
  RuntimeQualificationLevel
} from '../../shared/generated-tools'
import { getJokerHomeDir } from '../store/paths'
import { readEffectiveRuntimeQualificationReport } from './qualification'
import type { ToolDefinition, ToolExecutionLifecycle, ToolResult } from '../tools/registry'
import type { ToolRisk } from '../tools/risk'
import { proposeGeneratedToolInvocation, updateGeneratedToolInvocation } from './invocation-store'
import { assertPathHasNoSymlink, resolveRootRelativePath } from './paths'
import { readGeneratedToolRegistry } from './registry'
import { compileGeneratedToolInputSchema } from './json-schema'
import { runGeneratedTool } from './runtime/runner'
import { generatedToolsRoot, verifyPublishedGeneratedToolBundle } from './store'
import { readGeneratedToolVersion } from './version-store'

export interface GeneratedToolSnapshotBinding {
  toolName: string
  toolId: string
  versionId: string
  fingerprint: string
  validationReportId: string
  pointerRevision: number
  capabilityRevision: number
  runtimeQualificationLevel: Exclude<RuntimeQualificationLevel, 'L0'>
  scope: GeneratedToolDescriptor['scope']
  projectId?: string
}

export interface GeneratedToolSnapshotOptions {
  jokerHome?: string
  projectId?: string
}

export interface GeneratedToolRuntimeInfo {
  protocolVersion: 1
  runtime: 'quickjs-wasm'
  methods: readonly ['initialize', 'tools/list', 'tools/call']
}

export function initializeGeneratedToolRuntime(): GeneratedToolRuntimeInfo {
  return {
    protocolVersion: 1,
    runtime: 'quickjs-wasm',
    methods: ['initialize', 'tools/list', 'tools/call']
  }
}

function schemaToZod(schema: Record<string, unknown>): z.ZodObject<z.ZodRawShape> {
  return compileGeneratedToolInputSchema(schema)
}

function readEntrypointSource(jokerHome: string, version: GeneratedToolVersion): string {
  const root = generatedToolsRoot(jokerHome)
  const versionRoot = resolveRootRelativePath(root, version.artifactPath)
  const entrypoint = resolveRootRelativePath(versionRoot, version.manifest.entrypoint)
  assertPathHasNoSymlink(versionRoot, entrypoint)
  const stat = lstatSync(entrypoint)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Generated Tool entrypoint is not a regular file')
  return readFileSync(entrypoint, 'utf8')
}

function ensureUniqueToolName(name: string, occupiedNames: ReadonlySet<string>): void {
  const folded = name.toLocaleLowerCase('en-US')
  if ([...occupiedNames].some((occupied) => occupied.toLocaleLowerCase('en-US') === folded)) {
    throw new Error(`Generated Tool name conflicts with an existing capability: ${name}`)
  }
}

function isVisibleInProject(descriptor: GeneratedToolDescriptor, projectId?: string): boolean {
  return descriptor.scope === 'user' || descriptor.projectId === projectId
}

interface ActiveGeneratedToolBinding extends Omit<GeneratedToolSnapshotBinding, 'runtimeQualificationLevel'> {}

function activeBindings(registry: GeneratedToolRegistryState, projectId?: string): ActiveGeneratedToolBinding[] {
  return registry.activePointers.flatMap((pointer) => {
    if (!pointer.activeVersionId) return []
    const entry = registry.entries.find((item) => item.toolId === pointer.toolId)
    if (!entry || !isVisibleInProject(entry.descriptor, projectId)
      || entry.descriptor.availability !== 'available'
      || entry.descriptor.activeVersionId !== pointer.activeVersionId) return []
    return [{
      toolName: pointer.toolId,
      toolId: pointer.toolId,
      versionId: pointer.activeVersionId,
      fingerprint: '',
      validationReportId: '',
      pointerRevision: pointer.revision,
      capabilityRevision: registry.capabilityRevision.revision,
      scope: entry.descriptor.scope,
      ...(entry.descriptor.projectId ? { projectId: entry.descriptor.projectId } : {})
    }]
  })
}

export function listGeneratedToolSnapshotBindings(
  jokerHomeOrOptions: string | GeneratedToolSnapshotOptions = getJokerHomeDir(),
  projectId?: string
): GeneratedToolSnapshotBinding[] {
  const options = typeof jokerHomeOrOptions === 'string'
    ? { jokerHome: jokerHomeOrOptions, projectId }
    : jokerHomeOrOptions
  const jokerHome = options.jokerHome ?? getJokerHomeDir()
  const qualification = readEffectiveRuntimeQualificationReport(jokerHome)
  if (!qualification || qualification.level === 'L0') return []
  const runtimeQualificationLevel: 'L2' | 'L1' = qualification.level
  const registry = readGeneratedToolRegistry(jokerHome)
  return activeBindings(registry, options.projectId).map((binding) => {
    const version = readGeneratedToolVersion(jokerHome, binding.toolId, binding.versionId)
    verifyPublishedGeneratedToolBundle(generatedToolsRoot(jokerHome), version)
    return {
      ...binding,
      toolName: version.manifest.toolId,
      fingerprint: version.fingerprint,
      validationReportId: version.validationReportId,
      runtimeQualificationLevel
    }
  })
}

function assertSnapshotStillExecutable(
  jokerHome: string,
  binding: GeneratedToolSnapshotBinding,
  projectId?: string
): GeneratedToolVersion {
  const registry = readGeneratedToolRegistry(jokerHome)
  if (registry.capabilityRevision.revision < binding.capabilityRevision) {
    throw new Error('Generated Tool capability revision regressed')
  }
  const pointer = registry.activePointers.find((item) => item.toolId === binding.toolId)
  const entry = registry.entries.find((item) => item.toolId === binding.toolId)
  if (!pointer || !entry || pointer.revision !== binding.pointerRevision || !isVisibleInProject(entry.descriptor, projectId)
    || entry.descriptor.availability !== 'available'
    || pointer.activeVersionId !== binding.versionId
    || entry.descriptor.activeVersionId !== binding.versionId) {
    throw new Error('Generated Tool is no longer active')
  }
  const version = readGeneratedToolVersion(jokerHome, binding.toolId, binding.versionId)
  if (version.fingerprint !== binding.fingerprint) throw new Error('Generated Tool snapshot fingerprint changed')
  if (version.validationReportId !== binding.validationReportId) throw new Error('Generated Tool validation report changed')
  return verifyPublishedGeneratedToolBundle(generatedToolsRoot(jokerHome), version)
}

function assertProjectReadRuntime(version: GeneratedToolVersion): void {
  const permissions = version.manifest.permissions
  if (permissions.filesystem.write.length > 0
    || permissions.network.hosts.length > 0
    || permissions.process.commands.length > 0
    || permissions.environment.keys.length > 0
    || permissions.secrets.handles.length > 0
    || version.manifest.dependencies.length > 0) {
    throw new Error('Generated Tool is outside the qualified project-read runtime profile')
  }
  if (version.manifest.outputSchema['type'] !== 'string') {
    throw new Error('Generated Tool output schema is unsupported by the text runtime')
  }
}

function deriveGeneratedToolRisk(version: GeneratedToolVersion): ToolRisk {
  assertProjectReadRuntime(version)
  return 'read'
}

function generatedInvocationLifecycle(
  jokerHome: string,
  binding: GeneratedToolSnapshotBinding
): ToolExecutionLifecycle {
  return {
    proposed: (event) => proposeGeneratedToolInvocation(jokerHome, {
      id: randomUUID(),
      idempotencyKey: `${event.context.sessionId}:${event.context.runId ?? event.context.sessionId}:${event.toolCallId}`,
      toolId: binding.toolId,
      versionId: binding.versionId,
      fingerprint: binding.fingerprint,
      sessionId: event.context.sessionId,
      runId: event.context.runId ?? event.context.sessionId,
      toolCallId: event.toolCallId,
      capabilityRevision: binding.capabilityRevision,
      request: event.input,
      proposedAt: event.occurredAt
    }),
    policyResolved: (state, event) => updateGeneratedToolInvocation(
      jokerHome,
      invocationId(state),
      invocationRevision(state),
      (current) => ({
        ...current,
        revision: current.revision + 1,
        status: 'policy',
        policyAt: event.occurredAt,
        policyDecision: event.decision.outcome
      })
    ),
    started: (state, event) => updateGeneratedToolInvocation(
      jokerHome,
      invocationId(state),
      invocationRevision(state),
      (current) => ({
        ...current,
        revision: current.revision + 1,
        status: 'started',
        startedAt: event.occurredAt
      })
    ),
    finished: (state, event) => {
      const denied = event.denied === true
      const outputHash = event.result && !denied
        ? createHash('sha256').update(event.result.output).digest('hex')
        : undefined
      updateGeneratedToolInvocation(
        jokerHome,
        invocationId(state),
        invocationRevision(state),
        (current) => ({
          ...current,
          revision: current.revision + 1,
          status: 'finished',
          finishedAt: event.occurredAt,
          outcome: denied
            ? 'cancelled'
            : event.error
              ? generatedInvocationOutcome(event.error, event.context.abortSignal)
              : 'succeeded',
          ...(outputHash ? { outputHash } : {}),
          ...(event.error ? { error: generatedInvocationError(event.error) } : {})
        })
      )
    }
  }
}

function invocationId(state: unknown): string {
  if (!state || typeof state !== 'object' || typeof (state as { id?: unknown }).id !== 'string') {
    throw new Error('Generated Tool invocation lifecycle state is missing an id')
  }
  return (state as { id: string }).id
}

function invocationRevision(state: unknown): number {
  if (!state || typeof state !== 'object' || typeof (state as { revision?: unknown }).revision !== 'number') {
    throw new Error('Generated Tool invocation lifecycle state is missing a revision')
  }
  return (state as { revision: number }).revision
}

function generatedInvocationOutcome(error: unknown, signal?: AbortSignal): 'failed' | 'cancelled' | 'timed-out' {
  const message = error instanceof Error ? error.message : String(error)
  if (signal?.aborted || message === 'cancelled') return 'cancelled'
  if (/timed out|timeout|budget/i.test(message)) return 'timed-out'
  return 'failed'
}

function generatedInvocationError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 16_000)
}

export async function callGeneratedTool(
  binding: GeneratedToolSnapshotBinding,
  input: Record<string, unknown>,
  context: { jokerHome?: string; projectId?: string; workspacePath: string; signal?: AbortSignal }
): Promise<ToolResult> {
  const jokerHome = context.jokerHome ?? getJokerHomeDir()
  const current = assertSnapshotStillExecutable(jokerHome, binding, context.projectId)
  assertProjectReadRuntime(current)
  const result = await runGeneratedTool({
    manifest: current.manifest,
    source: readEntrypointSource(jokerHome, current),
    workspacePath: context.workspacePath,
    input,
    signal: context.signal
  })
  if (!result.ok) {
    throw new Error(typeof result.error === 'string'
      ? result.error
      : JSON.stringify(result.error ?? 'Generated Tool execution failed'))
  }
  const output = typeof result.output === 'string' ? result.output : JSON.stringify(result.output)
  return {
    output,
    metadata: {
      generatedTool: {
        toolId: binding.toolId,
        versionId: binding.versionId,
        fingerprint: binding.fingerprint,
        validationReportId: binding.validationReportId,
        pointerRevision: binding.pointerRevision,
        capabilityRevision: binding.capabilityRevision,
        outputHash: createHash('sha256').update(output).digest('hex'),
        manifestHash: current.manifestHash
      }
    }
  }
}

export function buildGeneratedToolDefinitions(
  workspacePath: string | null,
  jokerHome = getJokerHomeDir(),
  bindings = listGeneratedToolSnapshotBindings(jokerHome),
  occupiedNames: ReadonlySet<string> = new Set(),
  projectId?: string
): ToolDefinition[] {
  if (!workspacePath) return []
  return bindings.map((binding) => {
    const version = assertSnapshotStillExecutable(jokerHome, binding, projectId)
    ensureUniqueToolName(binding.toolName, occupiedNames)
    return {
      name: binding.toolName,
      description: `[Generated Tool] ${version.manifest.description}`,
      source: {
        type: 'generated' as const,
        toolId: binding.toolId,
        name: version.manifest.displayName,
        versionId: binding.versionId,
        fingerprint: binding.fingerprint,
        validationReportId: binding.validationReportId,
        pointerRevision: binding.pointerRevision,
        capabilityRevision: binding.capabilityRevision,
        runtimeQualificationLevel: binding.runtimeQualificationLevel
      },
      risk: deriveGeneratedToolRisk(version),
      lifecycle: generatedInvocationLifecycle(jokerHome, binding),
      inputSchema: schemaToZod(version.manifest.inputSchema),
      execute: async (input, context): Promise<ToolResult> => {
        if (!context.workspacePath) throw new Error('Generated Tool requires a workspace')
        return callGeneratedTool(binding, input, {
          jokerHome,
          projectId,
          workspacePath: context.workspacePath,
          signal: context.abortSignal
        })
      }
    }
  })
}
