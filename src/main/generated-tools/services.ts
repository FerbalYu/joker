import type { GeneratedToolsEventBus } from './event-bus'
import type { TraceSink } from './trace'
import type { ForgeService } from './forge-service'
import type { PromotionService } from './promotion-service'
import type { ContinuationScheduler } from './continuation-scheduler'
import type { RuntimeQualificationService } from './runtime-qualification-service'

export interface GeneratedToolsServiceBundle {
  forge: ForgeService
  promotion: PromotionService
  continuation: ContinuationScheduler
  qualification: RuntimeQualificationService
  events: GeneratedToolsEventBus
  trace: TraceSink
}
