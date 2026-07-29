import type { ChatImagePart, ChatMessage, ChatPart } from './types'

export const ALLOWED_IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_IMAGES_PER_MESSAGE = 4
export const MAX_MESSAGE_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_IMAGE_DIMENSION = 1280
export const MAX_IMAGE_PIXELS = 32_000_000

export interface ImageDimensions {
  width: number
  height: number
  resized: boolean
}

export function getImageResizeDimensions(width: number, height: number): ImageDimensions {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('Invalid image dimensions')
  }

  const scale = Math.min(1, MAX_IMAGE_DIMENSION / width, MAX_IMAGE_DIMENSION / height)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    resized: scale < 1
  }
}

export function isAllowedImageMediaType(mediaType: string): boolean {
  return (ALLOWED_IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType.toLowerCase())
}

export function base64ByteSize(data: string): number {
  const normalized = data.replace(/\s/g, '')
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) return -1
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding)
}

export function validateImagePart(part: unknown): part is ChatImagePart {
  if (!part || typeof part !== 'object') return false
  const value = part as Partial<ChatImagePart>
  if (value.type !== 'image' || typeof value.data !== 'string' || typeof value.mediaType !== 'string') return false
  if (!isAllowedImageMediaType(value.mediaType)) return false
  const bytes = base64ByteSize(value.data)
  if (bytes <= 0 || bytes > MAX_IMAGE_BYTES) return false
  return value.sizeBytes === undefined || value.sizeBytes === bytes
}

export function validateChatParts(parts: unknown): parts is ChatPart[] {
  if (!Array.isArray(parts) || parts.length === 0) return false
  const images = parts.filter((part) => typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'image')
  if (images.length > MAX_IMAGES_PER_MESSAGE || images.reduce((total, part) => total + (typeof (part as ChatImagePart).data === 'string' ? base64ByteSize((part as ChatImagePart).data) : 0), 0) > MAX_MESSAGE_IMAGE_BYTES) return false
  return parts.every((part) => {
    if (!part || typeof part !== 'object') return false
    const value = part as { type?: unknown; text?: unknown }
    return value.type === 'text' ? typeof value.text === 'string' : validateImagePart(part)
  })
}

export function getMessageText(message: Pick<ChatMessage, 'content' | 'parts'>): string {
  if (message.parts) return message.parts.filter((part) => part.type === 'text').map((part) => part.text).join('')
  return message.content
}

export function imagePreviewUrl(part: ChatImagePart): string {
  return `data:${part.mediaType};base64,${part.data}`
}
