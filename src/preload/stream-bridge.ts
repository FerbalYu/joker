import type { StreamEvent, StreamEventEnvelope, StreamFlowState } from '../shared/types'

export interface StreamPortLike {
  onmessage: ((event: MessageEvent) => void) | null
  postMessage: (message: unknown) => void
  start: () => void
  close?: () => void
}

type PortCallback = (port: StreamPortLike) => void
type EventCallback = (event: StreamEvent) => void
type FlowCallback = (flow: StreamFlowState) => void

export class StreamBridge {
  private port: StreamPortLike | null = null
  private readonly portCallbacks = new Set<PortCallback>()
  private readonly eventCallbacks = new Set<EventCallback>()
  private readonly flowCallbacks = new Set<FlowCallback>()

  constructor(private readonly initialCredit: number) {}

  acceptPort(port: StreamPortLike): void {
    const previous = this.port
    if (previous && previous !== port) {
      previous.onmessage = null
      try { previous.close?.() } catch { /* Replacement must still become active. */ }
    }
    this.port = port
    port.onmessage = (event: MessageEvent) => this.handleMessage(port, event)
    port.start()
    port.postMessage({ type: 'stream:ready', credit: this.initialCredit })
    for (const callback of this.portCallbacks) callback(port)
  }

  onPort(callback: PortCallback): () => void {
    this.portCallbacks.add(callback)
    if (this.port) callback(this.port)
    return () => this.portCallbacks.delete(callback)
  }

  onEvent(callback: EventCallback): () => void {
    this.eventCallbacks.add(callback)
    return () => this.eventCallbacks.delete(callback)
  }

  onFlow(callback: FlowCallback): () => void {
    this.flowCallbacks.add(callback)
    return () => this.flowCallbacks.delete(callback)
  }

  send(message: unknown): boolean {
    if (!this.port) return false
    try {
      this.port.postMessage(message)
      return true
    } catch (error) {
      console.error('Failed to send stream message', error)
      return false
    }
  }

  private handleMessage(sourcePort: StreamPortLike, event: MessageEvent): void {
    const data = event.data as StreamEventEnvelope | { type: 'stream:flow'; flow: StreamFlowState }
    if (data?.type === 'stream:flow') {
      if (sourcePort === this.port) for (const callback of this.flowCallbacks) callback(data.flow)
      return
    }
    if (data?.type !== 'stream:event') return
    const streamEvent = { ...data.event, runId: data.runId } as StreamEvent
    try {
      if (sourcePort === this.port) {
        for (const callback of this.eventCallbacks) callback(streamEvent)
      }
    } catch (error) {
      console.error('Failed to handle stream event', error)
    } finally {
      try {
        sourcePort.postMessage({ type: 'stream:ack', seq: data.seq, runId: data.runId })
      } catch (error) {
        console.error('Failed to acknowledge stream event', error)
      }
    }
  }
}
