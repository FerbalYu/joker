import { NodeService } from './node-service'
import { CordisRuntime, createNodeServicePlugin, type CordisPlugin } from './cordis'

let runtime: CordisRuntime | undefined
let nodeService: NodeService | undefined

export async function startNodeRuntime(plugins: CordisPlugin[] = []): Promise<{ host: string; port: number; url: string }> {
  if (runtime && nodeService) {
    return nodeService.start()
  }
  runtime = new CordisRuntime()
  nodeService = new NodeService({ name: 'joker-node-service' })
  await runtime.use(createNodeServicePlugin(nodeService))
  for (const plugin of plugins) await runtime.use(plugin)
  await runtime.start()
  return nodeService.start()
}

export async function stopNodeRuntime(): Promise<void> {
  if (!runtime) return
  await runtime.stop()
  runtime = undefined
  nodeService = undefined
}

export function getNodeRuntime(): { runtime?: CordisRuntime; nodeService?: NodeService } {
  return { runtime, nodeService }
}
