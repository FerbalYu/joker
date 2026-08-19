import { ForgeService } from './forge-service'
import { PromotionService } from './promotion-service'
import { ContinuationScheduler } from './continuation-scheduler'
import { RuntimeQualificationService } from './runtime-qualification-service'
import { setDefaultForgeService, setDefaultPromotionService } from './forge-service-runtime'
import { setDefaultContinuationScheduler } from './continuation-scheduler-runtime'
import { setDefaultRuntimeQualificationService } from './runtime-qualification-service-runtime'
import type { CordisPlugin } from '../runtime/cordis'
import { setGeneratedToolsCordisRuntime } from './cordis-runtime'
import { GeneratedToolsEventBus } from './event-bus'
import { MemoryTraceSink } from './trace'

export interface GeneratedToolsCordisOptions {
  jokerHome: string
}

export interface GeneratedToolsCordisServices {
  forge: ForgeService
  promotion: PromotionService
  continuation: ContinuationScheduler
  qualification: RuntimeQualificationService
  events: GeneratedToolsEventBus
  trace: MemoryTraceSink
}

export function createGeneratedToolsCordisPlugin(
  options: GeneratedToolsCordisOptions
): CordisPlugin & { services?: GeneratedToolsCordisServices } {
  const services: Partial<GeneratedToolsCordisServices> = {}
  const plugin: CordisPlugin & { services?: GeneratedToolsCordisServices } = {
    name: 'generated-tools',
    async apply(context) {
      setGeneratedToolsCordisRuntime(context.runtime)
      const qualification = new RuntimeQualificationService({ jokerHome: options.jokerHome })
      const events = new GeneratedToolsEventBus()
      const trace = new MemoryTraceSink()
      const continuation = new ContinuationScheduler({ jokerHome: options.jokerHome })
      const promotion = new PromotionService({ jokerHome: options.jokerHome, continuationScheduler: continuation })
      const forge = new ForgeService({
        jokerHome: options.jokerHome,
        events,
        traceSink: trace,
        activationDriver: promotion.advance.bind(promotion)
      })
      const owned = { forge, promotion, continuation, qualification, events, trace }
      Object.assign(services, owned)
      plugin.services = owned

      context.provide('generated-tools.forge', forge)
      context.provide('generated-tools.promotion', promotion)
      context.provide('generated-tools.continuation', continuation)
      context.provide('generated-tools.qualification', qualification)
      context.provide('generated-tools.events', events)
      context.provide('generated-tools.trace', trace)

      // Compatibility bridge: existing IPC/tool callers resolve the same Cordis-owned instances.
      setDefaultForgeService(forge)
      setDefaultPromotionService(promotion)
      setDefaultContinuationScheduler(continuation)
      setDefaultRuntimeQualificationService(qualification)

      qualification.recover()
      continuation.recover()
      await promotion.recover()
      forge.start()

      context.onDispose(async () => {
        await forge.stop()
        setDefaultForgeService(null)
        setDefaultPromotionService(null)
        setDefaultContinuationScheduler(null)
        setDefaultRuntimeQualificationService(null)
        setGeneratedToolsCordisRuntime(undefined)
      })
    }
  }
  return plugin
}
