import type { SkillDescriptor, SkillTrustState } from '../../shared/types'

export interface ParsedSkill extends SkillDescriptor {
  path: string
  fingerprint: string
  trustState: SkillTrustState
}
