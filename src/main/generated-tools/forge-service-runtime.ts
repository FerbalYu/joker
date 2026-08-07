import type { ForgeController, ForgeService } from './forge-service'
import type { PromotionService } from './promotion-service'

let defaultPromotionService: PromotionService | null = null
let defaultForgeService: ForgeService | null = null

export function setDefaultPromotionService(service: PromotionService | null): void {
  defaultPromotionService = service
}

export function getDefaultPromotionService(): PromotionService | undefined {
  return defaultPromotionService ?? undefined
}


export function setDefaultForgeService(service: ForgeService | null): void {
  defaultForgeService = service
}

export function getDefaultForgeController(): ForgeController | undefined {
  return defaultForgeService ?? undefined
}

export async function stopDefaultForgeService(): Promise<void> {
  const service = defaultForgeService
  defaultForgeService = null
  await service?.stop()
}
