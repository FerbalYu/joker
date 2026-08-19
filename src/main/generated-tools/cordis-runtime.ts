import { CordisRuntime } from '../runtime/cordis'
import type { ContinuationScheduler } from './continuation-scheduler'
import type { ForgeController } from './forge-service'
import type { PromotionService } from './promotion-service'
import type { RuntimeQualificationService } from './runtime-qualification-service'

let runtime: CordisRuntime | undefined

export function setGeneratedToolsCordisRuntime(value: CordisRuntime | undefined): void {
  runtime = value
}

export function getGeneratedToolsCordisRuntime(): CordisRuntime | undefined {
  return runtime
}

export function getCordisForgeController(): ForgeController | undefined {
  return runtime?.get<ForgeController>('generated-tools.forge')
}

export function getCordisPromotionService(): PromotionService | undefined {
  return runtime?.get<PromotionService>('generated-tools.promotion')
}

export function getCordisContinuationScheduler(): ContinuationScheduler | undefined {
  return runtime?.get<ContinuationScheduler>('generated-tools.continuation')
}

export function getCordisQualificationService(): RuntimeQualificationService | undefined {
  return runtime?.get<RuntimeQualificationService>('generated-tools.qualification')
}
