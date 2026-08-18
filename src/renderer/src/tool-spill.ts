import type { SpilledToolResultChunk } from '@shared/types'

export interface ToolResultSpillRefView {
  id: string
  bytes: number
  sha256?: string
  preview?: string
  truncated: true
}

export interface SpillReadState {
  content: string
  loadedBytes: number
  nextOffsetBytes: number
  totalBytes?: number
  eof: boolean
}

export const initialSpillReadState: SpillReadState = {
  content: '',
  loadedBytes: 0,
  nextOffsetBytes: 0,
  eof: false
}

export function getToolResultSpill(metadata: Record<string, unknown> | undefined): ToolResultSpillRefView | null {
  const value = metadata?.spill
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const spill = value as Record<string, unknown>
  if (typeof spill.id !== 'string' || !/^[a-f0-9]{64}$/.test(spill.id)) return null
  if (typeof spill.bytes !== 'number' || !Number.isFinite(spill.bytes) || spill.bytes < 0) return null
  return {
    id: spill.id,
    bytes: Math.floor(spill.bytes),
    ...(typeof spill.sha256 === 'string' && /^[a-f0-9]{64}$/.test(spill.sha256) ? { sha256: spill.sha256 } : {}),
    ...(typeof spill.preview === 'string' ? { preview: spill.preview } : {}),
    truncated: true
  }
}

export function appendSpillChunk(state: SpillReadState, chunk: SpilledToolResultChunk): SpillReadState {
  if (chunk.offsetBytes !== state.nextOffsetBytes) throw new Error('Spill chunk offset mismatch')
  if (!Number.isSafeInteger(chunk.totalBytes) || chunk.totalBytes < 0) throw new Error('Invalid spill size')
  if (!Number.isSafeInteger(chunk.contentBytes) || chunk.contentBytes < 0) throw new Error('Invalid spill chunk size')
  if (new TextEncoder().encode(chunk.content).length !== chunk.contentBytes) throw new Error('Spill chunk byte length mismatch')
  if (state.totalBytes !== undefined && chunk.totalBytes !== state.totalBytes) throw new Error('Spill total size changed')
  const nextOffsetBytes = chunk.nextOffsetBytes ?? chunk.offsetBytes + chunk.contentBytes
  if (!Number.isSafeInteger(nextOffsetBytes) || nextOffsetBytes < chunk.offsetBytes || nextOffsetBytes > chunk.totalBytes) throw new Error('Invalid spill cursor')
  if (nextOffsetBytes - chunk.offsetBytes !== chunk.contentBytes) throw new Error('Spill cursor does not match chunk size')
  if (chunk.eof !== (nextOffsetBytes >= chunk.totalBytes)) throw new Error('Spill EOF does not match cursor')
  if (!chunk.eof && nextOffsetBytes === chunk.offsetBytes) throw new Error('Spill cursor did not advance')
  return {
    content: state.content + chunk.content,
    loadedBytes: nextOffsetBytes,
    nextOffsetBytes,
    totalBytes: chunk.totalBytes,
    eof: chunk.eof
  }
}
