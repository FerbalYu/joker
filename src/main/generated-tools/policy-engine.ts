import type { GeneratedToolPermissionManifest } from '../../shared/generated-tools'

export interface GeneratedToolPolicyContext {
  operation: 'promote' | 'execute'
  toolId: string
  permissions: GeneratedToolPermissionManifest
  workspaceFullTrustGranted: boolean
  runtimeQualificationLevel: 'L2' | 'L1' | 'L0'
}

export interface GeneratedToolPolicyResult {
  action: 'allow' | 'ask' | 'deny'
  reasonCode: string
  reason: string
  policyVersion: string
}

export interface GeneratedToolPolicyEngine {
  evaluate(context: GeneratedToolPolicyContext): GeneratedToolPolicyResult
}

export class DefaultGeneratedToolPolicyEngine implements GeneratedToolPolicyEngine {
  evaluate(context: GeneratedToolPolicyContext): GeneratedToolPolicyResult {
    if (context.runtimeQualificationLevel === 'L0') return { action: 'deny', reasonCode: 'runtime-l0', reason: 'Runtime qualification is unavailable', policyVersion: 'policy-engine-v1' }
    if (!context.workspaceFullTrustGranted && context.permissions.filesystem.write.length > 0) return { action: 'ask', reasonCode: 'workspace-full-trust-required', reason: 'Filesystem write permission requires explicit workspace trust', policyVersion: 'policy-engine-v1' }
    return { action: 'allow', reasonCode: 'policy-default-allow', reason: 'Policy prerequisites satisfied', policyVersion: 'policy-engine-v1' }
  }
}
