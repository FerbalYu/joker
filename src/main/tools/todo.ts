import { z } from 'zod'
import type { ToolDefinition, ToolResult, ToolContext } from './registry'

// In-memory todo store (per session)
const todoStore = new Map<string, TodoItem[]>()

interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  priority: 'high' | 'medium' | 'low'
}

export const todoTool: ToolDefinition = {
  name: 'TodoWrite',
  description:
    'Update the task list for the current session. Use this to track progress on multi-step tasks. Each call replaces the full todo list.',
  inputSchema: z.object({
    todos: z
      .array(
        z.object({
          content: z.string(),
          status: z.enum(['pending', 'in_progress', 'completed']),
          priority: z.enum(['high', 'medium', 'low']).optional()
        })
      )
      .describe('The complete todo list (replaces existing)')
  }),
  execute: async (input, context: ToolContext): Promise<ToolResult> => {
    const { todos } = input as { todos: Array<Omit<TodoItem, 'id'>> }
    const items: TodoItem[] = todos.map((t, i) => ({
      id: `todo-${i}`,
      content: t.content,
      status: t.status,
      priority: t.priority ?? 'medium'
    }))
    todoStore.set(context.sessionId, items)

    const summary = items
      .map((t) => {
        const icon = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[>]' : '[ ]'
        return `${icon} ${t.content}`
      })
      .join('\n')

    const completed = items.filter((t) => t.status === 'completed').length
    return {
      output: `Todo list updated (${completed}/${items.length} completed):\n${summary}`
    }
  }
}

export function getTodos(sessionId: string): TodoItem[] {
  return todoStore.get(sessionId) ?? []
}

export function clearTodos(sessionId?: string): void {
  if (sessionId) todoStore.delete(sessionId)
  else todoStore.clear()
}

export const todoTools: ToolDefinition[] = [todoTool]
