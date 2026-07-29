import { fileURLToPath } from 'node:url'

export function fileUrlToLocalPath(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'file:') throw new Error('Only file URLs are allowed')
  url.search = ''
  url.hash = ''
  return fileURLToPath(url)
}
