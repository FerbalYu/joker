export type GeneratedToolsEventMap = {
  'forge.job.queued': { jobId: string; toolId: string; status: string }
  'forge.job.phase': { jobId: string; toolId: string; from?: string; to: string }
  'forge.job.completed': { jobId: string; toolId: string; status: string }
  'forge.job.failed': { jobId: string; toolId: string; error: string }
  'generated-tool.promoted': { jobId: string; toolId: string; versionId?: string; capabilityRevision?: number }
  'generated-tool.invoked': { toolId: string; versionId: string; outcome: string }
}

export type GeneratedToolsEventName = keyof GeneratedToolsEventMap
export type GeneratedToolsEventListener<K extends GeneratedToolsEventName> = (event: GeneratedToolsEventMap[K]) => void

export class GeneratedToolsEventBus {
  private readonly listeners = new Map<GeneratedToolsEventName, Set<(event: unknown) => void>>()

  on<K extends GeneratedToolsEventName>(name: K, listener: GeneratedToolsEventListener<K>): () => void {
    const listeners = this.listeners.get(name) ?? new Set<(event: unknown) => void>()
    listeners.add(listener as (event: unknown) => void)
    this.listeners.set(name, listeners)
    return () => listeners.delete(listener as (event: unknown) => void)
  }

  emit<K extends GeneratedToolsEventName>(name: K, event: GeneratedToolsEventMap[K]): void {
    for (const listener of this.listeners.get(name) ?? []) {
      try { listener(event) } catch (error) { console.error(`[generated-tools:event:${name}] listener failed`, error) }
    }
  }

  clear(): void { this.listeners.clear() }
}
