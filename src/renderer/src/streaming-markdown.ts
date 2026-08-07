export interface StreamingMarkdownPartition {
  blocks: string[]
  tail: string
}

export function partitionStreamingMarkdown(content: string): StreamingMarkdownPartition {
  const blocks: string[] = []
  let blockStart = 0
  let offset = 0
  let fence: { marker: '`' | '~'; length: number } | null = null

  for (const line of content.match(/.*(?:\n|$)/g) ?? []) {
    if (!line) continue
    const lineWithoutNewline = line.endsWith('\n') ? line.slice(0, -1) : line
    const marker = lineWithoutNewline.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1]
    if (marker) {
      const markerType = marker[0] as '`' | '~'
      if (!fence) fence = { marker: markerType, length: marker.length }
      else if (fence.marker === markerType && marker.length >= fence.length && /^ {0,3}(`{3,}|~{3,})\s*$/u.test(lineWithoutNewline)) fence = null
    }

    offset += line.length
    if (!fence && lineWithoutNewline.trim() === '' && offset > blockStart) {
      const block = content.slice(blockStart, offset)
      if (block.trim()) blocks.push(block)
      blockStart = offset
    }
  }

  return { blocks, tail: content.slice(blockStart) }
}
