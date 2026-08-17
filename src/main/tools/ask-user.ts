import { z } from 'zod'
import type { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import type { ToolDefinition, ToolResult, ToolContext } from './registry'
import { askUserQuestion } from '../agent/user-question'

const questionInputSchema = z.object({
  question: z.string().min(1).describe('The specific question to ask the user'),
  header: z.string().optional().describe('Optional short heading, e.g. "Confirm" or "Choose mode"'),
  multiSelect: z.boolean().optional().describe('Whether more than one option may be selected'),
  options: z.array(z.object({
    label: z.string().min(1).describe('Short user-facing option label'),
    description: z.string().optional().describe('One sentence explaining the tradeoff or impact')
  })).optional().describe('Optional choices to show; put the recommended one first'),
  allowFreeText: z.boolean().optional().describe('Whether the user may answer with free text (default true)')
})

export type AskUserQuestionInput = z.infer<typeof questionInputSchema>

export function buildAskUserTools(win: BrowserWindow): ToolDefinition[] {
  const askUserTool: ToolDefinition = {
    name: 'AskUserQuestion',
    description:
      'Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. ' +
      'Send one or more questions in a single call; each question may offer labeled options (put the recommended option first) and allow free text. ' +
      'Use this instead of guessing when the decision belongs to the user.',
    inputSchema: z.object({
      questions: z.array(questionInputSchema).min(1).describe('Questions to ask before continuing')
    }),
    risk: 'read',
    execute: async (input, context: ToolContext): Promise<ToolResult> => {
      const { questions } = input as { questions: AskUserQuestionInput[] }
      const answers: string[] = []
      for (const [index, question] of questions.entries()) {
        const options = (question.options ?? []).slice(0, 8).map((option, optionIndex) => ({
          id: `q${index}-o${optionIndex}`,
          label: option.label,
          ...(option.description ? { description: option.description } : {})
        }))
        const request = {
          requestId: randomUUID(),
          sessionId: context.sessionId,
          runId: context.runId ?? 'run',
          ...(question.header ? { header: question.header } : {}),
          question: question.question,
          multiSelect: question.multiSelect ?? false,
          options,
          allowFreeText: question.allowFreeText ?? true
        }
        const answer = await askUserQuestion(win, request)
        if (answer.cancelled) {
          const suffix = answers.length > 0 ? ` (after ${answers.length} answered question(s))` : ''
          return { output: `The user dismissed the question${suffix}. Treat missing answers as unavailable and continue with the safest option, or state what you need.` }
        }
        const chosen = answer.selectedIds
          .map((id) => options.find((option) => option.id === id)?.label)
          .filter((label): label is string => Boolean(label))
        const parts = [chosen.length > 0 ? chosen.join('; ') : '', answer.freeText ?? ''].filter(Boolean)
        answers.push(parts.length > 0 ? parts.join(' — ') : '(empty answer)')
      }
      return { output: answers.map((answer, index) => `Q${index + 1}: ${questions[index]?.question ?? ''}\nA: ${answer}`).join('\n\n') }
    }
  }
  return [askUserTool]
}
