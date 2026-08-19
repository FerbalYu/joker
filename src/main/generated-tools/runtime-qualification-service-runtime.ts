import type { RuntimeQualificationService } from './runtime-qualification-service'
import { getCordisQualificationService } from './cordis-runtime'

let defaultRuntimeQualificationService: RuntimeQualificationService | null = null

export function setDefaultRuntimeQualificationService(service: RuntimeQualificationService | null): void {
  defaultRuntimeQualificationService = service
}

export function getDefaultRuntimeQualificationService(): RuntimeQualificationService | undefined {
  return getCordisQualificationService() ?? defaultRuntimeQualificationService ?? undefined
}

export function stopDefaultRuntimeQualificationService(): void {
  defaultRuntimeQualificationService?.stop()
  defaultRuntimeQualificationService = null
}
