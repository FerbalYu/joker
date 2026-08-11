import type { GeneratedToolSpec, GeneratedToolValidationPlan, GeneratedToolValidationProfileId } from '../../shared/generated-tools'
import { compileGeneratedToolValidationPlan, fingerprintGeneratedToolValidationPlan } from './validation-suite'

export type ForgePreflightBlocker =
  | 'validation-suite-unavailable'
  | 'unsupported-runtime-profile'
  | 'workspace-full-trust-required'
  | 'invalid-contract'

export type ForgePreflightOptions = {
  workspacePath?: string | null
  projectWorkspacePath?: string | null
  workspaceFullTrustGranted?: boolean
}

export type ForgePreflightResult =
  | {
      ok: true
      validationProfile: GeneratedToolValidationProfileId
      validationPlan: GeneratedToolValidationPlan
      validationPlanHash: string
    }
  | {
      ok: false
      blocker: ForgePreflightBlocker
      reason: string
      supportedProfile: 'gate2-project-read-v1' | 'user-owned-full-trust-v1'
    }

const FULL_TRUST_PROFILE = 'user-owned-full-trust-v1' as const

export function generatedToolValidationProfile(spec: Pick<GeneratedToolSpec, 'validationProfile'>): GeneratedToolValidationProfileId {
  // ToolForge is deliberately unrestricted.  The profile remains in the
  // persisted shape for backwards compatibility, but no longer selects a
  // constrained runner or enables a policy gate.
  void spec
  return FULL_TRUST_PROFILE
}

export function preflightGeneratedToolSpec(spec: GeneratedToolSpec, options: ForgePreflightOptions = {}): ForgePreflightResult {
  void options
  const validationPlan = compileGeneratedToolValidationPlan(spec)
  return {
    ok: true,
    validationProfile: FULL_TRUST_PROFILE,
    validationPlan,
    validationPlanHash: fingerprintGeneratedToolValidationPlan(validationPlan)
  }
}

export function assertGeneratedToolSpecSupported(spec: GeneratedToolSpec, options?: ForgePreflightOptions): {
  validationProfile: GeneratedToolValidationProfileId
  validationPlan: GeneratedToolValidationPlan
  validationPlanHash: string
} {
  const result = preflightGeneratedToolSpec(spec, options)
  if (!result.ok) throw new Error(`${result.blocker}: ${result.reason}`)
  return result
}
