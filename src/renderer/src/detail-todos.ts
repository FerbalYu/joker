import type { ChatMessage, ToolCallInfo } from '@shared/types'

export interface DetailTodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  priority: 'high' | 'medium' | 'low'
}

export interface DetailTodoState {
  items: DetailTodoItem[]
  completed: number
  total: number
}

export function latestTodoState(toolCalls: ToolCallInfo[], messages: ChatMessage[] = []): DetailTodoState | null {
  const current = findLatestTodoCall(toolCalls)
  if (current) return stateFromTodoCall(current)

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]
    if (!message || message.role !== 'assistant') continue
    const messageTools = message.segments?.flatMap((segment) => segment.type === 'tools' ? segment.tools : []) ?? message.toolCalls ?? []
    const historical = findLatestTodoCall(messageTools)
    if (historical) return stateFromTodoCall(historical)
  }
  return null
}

function findLatestTodoCall(toolCalls: ToolCallInfo[]): ToolCallInfo | null {
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const toolCall = toolCalls[index]
    if (toolCall?.toolName === 'TodoWrite') return toolCall
  }
  return null
}

function stateFromTodoCall(toolCall: ToolCallInfo): DetailTodoState | null {
  const todos = toolCall.input.todos
  if (!Array.isArray(todos)) return null

  const items = todos.filter(isTodoItem).map((todo) => ({
    content: todo.content,
    status: todo.status,
    priority: todo.priority ?? 'medium'
  }))
  if (items.length === 0 && todos.length > 0) return null
  return {
    items,
    completed: items.filter((todo) => todo.status === 'completed').length,
    total: items.length
  }
}

function isTodoItem(value: unknown): value is { content: string; status: DetailTodoItem['status']; priority?: DetailTodoItem['priority'] } {
  if (!value || typeof value !== 'object') return false
  const todo = value as { content?: unknown; status?: unknown; priority?: unknown }
  return typeof todo.content === 'string' &&
    (todo.status === 'pending' || todo.status === 'in_progress' || todo.status === 'completed') &&
    (todo.priority === undefined || todo.priority === 'high' || todo.priority === 'medium' || todo.priority === 'low')
}
