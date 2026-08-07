import type { RuntimeQualificationService } from './runtime-qualification-service'

let defaultRuntimeQualificationService: RuntimeQualificationService | null = null

export function setDefaultRuntimeQualificationService(service: RuntimeQualificationService | null): void {
  defaultRuntimeQualificationService = service
}

export function getDefaultRuntimeQualificationService(): RuntimeQualificationService | undefined {
  return defaultRuntimeQualificationService ?? undefined
}

export function stopDefaultRuntimeQualificationService(): void {
  defaultRuntimeQualificationService?.stop()
  defaultRuntimeQualificationService = null
}
