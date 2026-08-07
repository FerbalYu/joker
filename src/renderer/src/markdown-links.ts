import { defaultUrlTransform } from 'react-markdown'
import { classifyLink } from './url-preview'

export function markdownUrlTransform(value: string): string {
  return classifyLink(value).kind === 'file' ? value : defaultUrlTransform(value)
}
