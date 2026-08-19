import type { NodeService } from './node-service'

export interface CordisContext {
  runtime: CordisRuntime
  service<T>(name: string): T | undefined
  provide<T>(name: string, value: T): void
  onDispose(disposer: () => void | Promise<void>): void
}

export interface CordisPlugin {
  name: string
  apply(context: CordisContext): void | Promise<void>
}

export class CordisRuntime {
  private readonly services = new Map<string, unknown>()
  private readonly disposers: Array<() => void | Promise<void>> = []
  private started = false

  get<T>(name: string): T | undefined {
    return this.services.get(name) as T | undefined
  }

  async use(plugin: CordisPlugin): Promise<void> {
    if (this.started) throw new Error('Cordis runtime has already started')
    const context: CordisContext = {
      runtime: this,
      service: <T>(name: string): T | undefined => this.services.get(name) as T | undefined,
      provide: <T>(name: string, value: T): void => {
        this.services.set(name, value)
      },
      onDispose: (disposer): void => {
        this.disposers.push(disposer)
      }
    }
    await plugin.apply(context)
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
  }

  async stop(): Promise<void> {
    while (this.disposers.length > 0) {
      await this.disposers.pop()?.()
    }
    this.services.clear()
    this.started = false
  }
}

export function createNodeServicePlugin(nodeService: NodeService): CordisPlugin {
  return {
    name: 'node-service',
    apply(context) {
      context.provide('node-service', nodeService)
      context.onDispose(() => nodeService.stop())
    }
  }
}
