// Host-owned compatibility contract for Generated Tool manifests.
// Keep this contract narrower than the manifest schema: it only answers whether
// the host can understand the version envelope before any execution or policy.

export const SUPPORTED_GENERATED_TOOL_SCHEMA_VERSIONS = Object.freeze([1] as const)
export const SUPPORTED_GENERATED_TOOL_SDK_VERSIONS = Object.freeze(['1.0.0', '1'] as const)
export const SUPPORTED_GENERATED_TOOL_RUNTIME_IDS = Object.freeze(['quickjs-wasm', 'node-child-process'] as const)
export const SUPPORTED_GENERATED_TOOL_RUNTIME_VERSIONS = Object.freeze(['0.32.0', '1'] as const)

export type SupportedGeneratedToolSchemaVersion = typeof SUPPORTED_GENERATED_TOOL_SCHEMA_VERSIONS[number]
export type SupportedGeneratedToolSdkVersion = typeof SUPPORTED_GENERATED_TOOL_SDK_VERSIONS[number]
export type SupportedGeneratedToolRuntimeId = typeof SUPPORTED_GENERATED_TOOL_RUNTIME_IDS[number]
export type SupportedGeneratedToolRuntimeVersion = typeof SUPPORTED_GENERATED_TOOL_RUNTIME_VERSIONS[number]

export interface GeneratedToolCompatibilityContract {
  schemaVersions: typeof SUPPORTED_GENERATED_TOOL_SCHEMA_VERSIONS
  sdkVersions: typeof SUPPORTED_GENERATED_TOOL_SDK_VERSIONS
  runtimes: readonly {
    id: SupportedGeneratedToolRuntimeId
    versions: readonly string[]
  }[]
}

const RUNTIME_VERSIONS = Object.freeze({
  'quickjs-wasm': Object.freeze(['0.32.0'] as const),
  'node-child-process': Object.freeze(['1'] as const)
})

export const GENERATED_TOOL_COMPATIBILITY_CONTRACT: GeneratedToolCompatibilityContract = Object.freeze({
  schemaVersions: SUPPORTED_GENERATED_TOOL_SCHEMA_VERSIONS,
  sdkVersions: SUPPORTED_GENERATED_TOOL_SDK_VERSIONS,
  runtimes: Object.freeze([
    Object.freeze({ id: 'quickjs-wasm' as const, versions: RUNTIME_VERSIONS['quickjs-wasm'] }),
    Object.freeze({ id: 'node-child-process' as const, versions: RUNTIME_VERSIONS['node-child-process'] })
  ])
})

export type GeneratedToolCompatibilityReasonCode =
  | 'invalid-input'
  | 'invalid-runtime'
  | 'unsupported-schema-version'
  | 'unsupported-sdk-version'
  | 'unsupported-runtime-id'
  | 'unsupported-runtime-version'

export interface GeneratedToolCompatibilityReason {
  code: GeneratedToolCompatibilityReasonCode
  field: 'manifest' | 'schemaVersion' | 'sdkVersion' | 'runtime' | 'runtime.id' | 'runtime.version'
  expected: readonly (string | number)[]
  actual?: string | number | null
}

export type GeneratedToolCompatibilityResult =
  | { compatible: true; contract: GeneratedToolCompatibilityContract }
  | { compatible: false; reasons: readonly GeneratedToolCompatibilityReason[] }

/**
 * Check only the host/version envelope. Unknown or malformed input never
 * passes, and every rejection is represented by a stable structured reason.
 */
export function checkGeneratedToolCompatibility(value: unknown): GeneratedToolCompatibilityResult {
  if (!isRecord(value)) {
    return {
      compatible: false,
      reasons: [{
        code: 'invalid-input',
        field: 'manifest',
        expected: ['object'],
        actual: value === null ? null : undefined
      }]
    }
  }

  const reasons: GeneratedToolCompatibilityReason[] = []
  const schemaVersion = value.schemaVersion
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) ||
    !SUPPORTED_GENERATED_TOOL_SCHEMA_VERSIONS.includes(schemaVersion as SupportedGeneratedToolSchemaVersion)) {
    reasons.push({
      code: 'unsupported-schema-version',
      field: 'schemaVersion',
      expected: SUPPORTED_GENERATED_TOOL_SCHEMA_VERSIONS,
      actual: toReasonValue(schemaVersion)
    })
  }

  const sdkVersion = value.sdkVersion
  if (typeof sdkVersion !== 'string' ||
    !SUPPORTED_GENERATED_TOOL_SDK_VERSIONS.includes(sdkVersion as SupportedGeneratedToolSdkVersion)) {
    reasons.push({
      code: 'unsupported-sdk-version',
      field: 'sdkVersion',
      expected: SUPPORTED_GENERATED_TOOL_SDK_VERSIONS,
      actual: toReasonValue(sdkVersion)
    })
  }

  if (!isRecord(value.runtime)) {
    reasons.push({
      code: 'invalid-runtime',
      field: 'runtime',
      expected: ['object'],
      actual: value.runtime === null ? null : undefined
    })
  } else {
    const runtimeId = value.runtime.id
    if (typeof runtimeId !== 'string' ||
      !SUPPORTED_GENERATED_TOOL_RUNTIME_IDS.includes(runtimeId as SupportedGeneratedToolRuntimeId)) {
      reasons.push({
        code: 'unsupported-runtime-id',
        field: 'runtime.id',
        expected: SUPPORTED_GENERATED_TOOL_RUNTIME_IDS,
        actual: toReasonValue(runtimeId)
      })
    }

    const runtimeVersion = value.runtime.version
    const versions = typeof runtimeId === 'string' && runtimeId in RUNTIME_VERSIONS
      ? RUNTIME_VERSIONS[runtimeId as keyof typeof RUNTIME_VERSIONS]
      : SUPPORTED_GENERATED_TOOL_RUNTIME_VERSIONS
    if (typeof runtimeVersion !== 'string' || !versions.includes(runtimeVersion as never)) {
      reasons.push({
        code: 'unsupported-runtime-version',
        field: 'runtime.version',
        expected: versions,
        actual: toReasonValue(runtimeVersion)
      })
    }
  }

  return reasons.length === 0
    ? { compatible: true, contract: GENERATED_TOOL_COMPATIBILITY_CONTRACT }
    : { compatible: false, reasons }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toReasonValue(value: unknown): string | number | null | undefined {
  if (typeof value === 'string' || typeof value === 'number' || value === null) return value
  return undefined
}
