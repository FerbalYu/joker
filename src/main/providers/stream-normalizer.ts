export interface ToolCallIndexState {
  readonly indexMap: Map<number, number>
  nextIndex: number
}

export function createToolCallIndexState(): ToolCallIndexState {
  return { indexMap: new Map(), nextIndex: 0 }
}

export function normalizeOpenAIToolCallIndices(value: unknown, state: ToolCallIndexState): unknown {
  if (!value || typeof value !== 'object') return value
  const payload = value as Record<string, unknown>
  const choices = payload.choices
  if (!Array.isArray(choices)) return value

  let changed = false
  const normalizedChoices = choices.map((choice) => {
    if (!choice || typeof choice !== 'object') return choice
    const choiceRecord = choice as Record<string, unknown>
    const delta = choiceRecord.delta
    if (!delta || typeof delta !== 'object') return choice
    const toolCalls = (delta as Record<string, unknown>).tool_calls
    if (!Array.isArray(toolCalls)) return choice

    const normalizedToolCalls = toolCalls.map((toolCall) => {
      if (!toolCall || typeof toolCall !== 'object') return toolCall
      const toolCallRecord = toolCall as Record<string, unknown>
      if (typeof toolCallRecord.index !== 'number' || !Number.isFinite(toolCallRecord.index)) return toolCall
      let normalizedIndex = state.indexMap.get(toolCallRecord.index)
      if (normalizedIndex === undefined) {
        normalizedIndex = state.nextIndex
        state.nextIndex += 1
        state.indexMap.set(toolCallRecord.index, normalizedIndex)
      }
      if (normalizedIndex === toolCallRecord.index) return toolCall
      changed = true
      return { ...toolCallRecord, index: normalizedIndex }
    })

    if (!normalizedToolCalls.some((toolCall, index) => toolCall !== toolCalls[index])) return choice
    changed = true
    return { ...choiceRecord, delta: { ...(delta as Record<string, unknown>), tool_calls: normalizedToolCalls } }
  })

  return changed ? { ...payload, choices: normalizedChoices } : value
}

function normalizeSseLine(line: string, state: ToolCallIndexState): string {
  if (!line.startsWith('data:')) return line
  const data = line.slice(5).trimStart()
  if (!data || data === '[DONE]') return line
  try {
    const parsed = JSON.parse(data)
    const normalized = normalizeOpenAIToolCallIndices(parsed, state)
    return normalized === parsed ? line : `data: ${JSON.stringify(normalized)}`
  } catch {
    return line
  }
}

export function normalizeOpenAIStreamingToolCallFetch(fetchImpl: typeof globalThis.fetch = globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init)
    const contentType = response.headers.get('content-type') ?? ''
    if (!response.body || !contentType.toLowerCase().includes('text/event-stream')) return response

    const state = createToolCallIndexState()
    const decoder = new TextDecoder()
    let pending = ''
    const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true })
        const lines = pending.split(/\r?\n/)
        pending = lines.pop() ?? ''
        for (const line of lines) controller.enqueue(new TextEncoder().encode(normalizeSseLine(line, state) + '\n'))
      },
      flush(controller) {
        pending += decoder.decode()
        if (pending) controller.enqueue(new TextEncoder().encode(normalizeSseLine(pending, state)))
      }
    }))

    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    })
  }
}
