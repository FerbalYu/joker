import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

export interface NodeServiceSnapshot {
  name: string
  status: 'ready'
  uptimeMs: number
}

export interface NodeServiceOptions {
  host?: string
  port?: number
  name?: string
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(body))
}

export class NodeService {
  private readonly server: Server
  private readonly startedAt = Date.now()
  private readonly host: string
  private readonly port: number
  private readonly name: string
  private listening = false

  constructor(options: NodeServiceOptions = {}) {
    this.host = options.host ?? '127.0.0.1'
    this.port = options.port ?? 0
    this.name = options.name ?? 'joker-node-service'
    this.server = createServer((request, response) => this.handle(request, response))
  }

  async start(): Promise<{ host: string; port: number; url: string }> {
    if (this.listening) return this.address()
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server.removeListener('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        this.server.removeListener('error', onError)
        this.listening = true
        resolve()
      }
      this.server.once('error', onError)
      this.server.once('listening', onListening)
      this.server.listen(this.port, this.host)
    })
    return this.address()
  }

  async stop(): Promise<void> {
    if (!this.listening) return
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve())
    })
    this.listening = false
  }

  snapshot(): NodeServiceSnapshot {
    return { name: this.name, status: 'ready', uptimeMs: Date.now() - this.startedAt }
  }

  private address(): { host: string; port: number; url: string } {
    const address = this.server.address()
    const port = typeof address === 'object' && address ? address.port : this.port
    return { host: this.host, port, url: `http://${this.host}:${port}` }
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== 'GET') {
      writeJson(response, 405, { error: 'method-not-allowed' })
      return
    }
    if (request.url === '/health') {
      writeJson(response, 200, { ok: true, service: this.snapshot() })
      return
    }
    if (request.url === '/services') {
      writeJson(response, 200, { services: [this.snapshot()] })
      return
    }
    writeJson(response, 404, { error: 'not-found' })
  }
}
