import test from 'node:test'
import assert from 'node:assert/strict'
import type { ChatMessage } from '../../shared/types'
import type { LanguageModel } from 'ai'
import { evaluateGoal, validateGoalEvaluationEvidence, type GoalEvaluation } from './evaluator'

function v3Usage() {
  return {
    inputTokens: { total: 30, noCache: 30, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 10, text: 10, reasoning: 0 }
  }
}

function evaluatorModel(output: unknown, inspect?: (options: Record<string, unknown>) => void): LanguageModel {
  return {
    specificationVersion: 'v3',
    provider: 'test',
    modelId: 'goal-evaluator',
    supportedUrls: {},
    doGenerate: async (options) => {
      inspect?.(options as unknown as Record<string, unknown>)
      return {
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: v3Usage(),
        response: { id: 'evaluation', modelId: 'goal-evaluator', timestamp: new Date(0) },
        content: [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output) }],
        warnings: []
      }
    },
    doStream: async () => { throw new Error('not used') }
  } as unknown as LanguageModel
}

function executionMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'execution-message-1',
    role: 'assistant',
    content: 'Implemented the parser. Focused tests passed: 12/12.',
    segments: [
      { type: 'text', text: 'Implemented the parser. ' },
      {
        type: 'tools',
        tools: [{
          toolCallId: 'test-call-1',
          toolName: 'Bash',
          input: { command: 'npm test' },
          output: 'Focused tests passed: 12/12.',
          status: 'done'
        }]
      },
      { type: 'text', text: 'Focused tests passed: 12/12.' }
    ],
    createdAt: 1,
    ...overrides
  }
}

function evaluation(overrides: Partial<GoalEvaluation> = {}): GoalEvaluation {
  return {
    decision: 'complete',
    criteria: [{ criterion: 'The parser is implemented and verified', satisfied: true }],
    evidenceReferences: [{
      source: 'tool_result',
      generation: 3,
      round: 2,
      messageId: 'execution-message-1',
      toolCallId: 'test-call-1',
      outputQuote: 'Focused tests passed: 12/12.'
    }],
    unmetCriteria: [],
    nextFeedback: '',
    ...overrides
  }
}

const input = {
  objective: 'Implement and verify the parser',
  generation: 3,
  round: 2,
  executionMessage: executionMessage()
}

void test('executor self-claim cannot complete without exact evidence', async () => {
  const selfClaim = executionMessage({
    content: 'I completed everything successfully.',
    segments: [{ type: 'text', text: 'I completed everything successfully.' }],
    toolCalls: undefined
  })
  const result = await evaluateGoal({ ...input, executionMessage: selfClaim }, {
    model: evaluatorModel(evaluation({ evidenceReferences: [] }))
  })

  assert.equal(result.success, false)
  assert.equal(result.error, 'invalid-evidence')
  assert.match(result.message, /requires exact execution evidence/)
})

void test('schema failure is reported with evaluator usage and no tools', async () => {
  let inspected: Record<string, unknown> | undefined
  const result = await evaluateGoal(input, {
    model: evaluatorModel({ decision: 'complete' }, (options) => { inspected = options })
  })

  assert.equal(result.success, false)
  assert.equal(result.error, 'schema-failure')
  assert.deepEqual(result.usage, {
    inputTokens: 30,
    outputTokens: 10,
    totalTokens: 40,
    noCacheTokens: 30,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    stepCount: 1
  })
  assert.equal(inspected?.['tools'], undefined)
  assert.ok(inspected?.['responseFormat'])
})

void test('host validation rejects fabricated generation and round references', () => {
  const validation = validateGoalEvaluationEvidence(evaluation({
    evidenceReferences: [{
      source: 'assistant_quote',
      generation: 99,
      round: 88,
      messageId: 'execution-message-1',
      quote: 'Implemented the parser.'
    }]
  }), input)

  assert.equal(validation.valid, false)
  assert.match(validation.errors.join(' '), /fabricated generation 99/)
  assert.match(validation.errors.join(' '), /fabricated round 88/)
})

void test('host validation rejects fabricated assistant and tool evidence', () => {
  const validation = validateGoalEvaluationEvidence(evaluation({
    evidenceReferences: [
      {
        source: 'assistant_quote',
        generation: 3,
        round: 2,
        messageId: 'execution-message-1',
        quote: 'All integration tests passed.'
      },
      {
        source: 'tool_result',
        generation: 3,
        round: 2,
        messageId: 'execution-message-1',
        toolCallId: 'invented-call',
        outputQuote: 'success'
      }
    ]
  }), input)

  assert.equal(validation.valid, false)
  assert.match(validation.errors.join(' '), /assistant quote is not exact/)
  assert.match(validation.errors.join(' '), /tool result invented-call does not exist/)
})

void test('valid exact tool evidence allows completion', async () => {
  const result = await evaluateGoal(input, { model: evaluatorModel(evaluation()) })

  assert.equal(result.success, true)
  assert.equal(result.success && result.evaluation.decision, 'complete')
  assert.equal(result.success && result.evaluation.evidenceReferences.length, 1)
  assert.equal(result.success && result.finishReason, 'stop')
})

void test('continue is valid with explicit unmet criteria and next feedback', async () => {
  const result = await evaluateGoal(input, {
    model: evaluatorModel(evaluation({
      decision: 'continue',
      criteria: [
        { criterion: 'The parser is implemented', satisfied: true },
        { criterion: 'The full typecheck passes', satisfied: false }
      ],
      evidenceReferences: [{
        source: 'assistant_quote',
        generation: 3,
        round: 2,
        messageId: 'execution-message-1',
        quote: 'Implemented the parser.'
      }],
      unmetCriteria: ['The full typecheck passes'],
      nextFeedback: 'Run the full typecheck and fix remaining errors.'
    }))
  })

  assert.equal(result.success, true)
  assert.equal(result.success && result.evaluation.decision, 'continue')
  assert.deepEqual(result.success && result.evaluation.unmetCriteria, ['The full typecheck passes'])
})
