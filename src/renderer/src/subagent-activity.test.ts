import test from 'node:test'
import assert from 'node:assert/strict'
import type { ChatMessage, SubagentActivity } from '@shared/types'
import { parseSubagentActivity, subagentActivitiesForView } from './subagent-activity'

function activity(overrides: Partial<SubagentActivity> = {}): SubagentActivity {
  return {
    id: 'subagent-1',
    task: 'Inspect the session data flow',
    status: 'completed',
    phase: 'completed',
    createdAt: 1,
    updatedAt: 3,
    completedAt: 3,
    currentStep: 2,
    maxSteps: 20,
    tools: [{ id: 'tool-1', toolName: 'Grep', summary: 'session · src', status: 'done', startedAt: 1, completedAt: 2, durationMs: 1 }],
    outputPreview: 'Found the runtime chain.',
    ...overrides
  }
}

void test('restores completed sub-agent activity from Agent tool metadata', () => {
  const stored = activity()
  const messages: ChatMessage[] = [{
    id: 'assistant-1',
    role: 'assistant',
    content: '',
    createdAt: 4,
    segments: [{ type: 'tools', tools: [{ toolCallId: 'agent-call', toolName: 'Agent', input: { prompt: stored.task }, output: 'done', status: 'done', metadata: { subagentActivity: stored } }] }]
  }]
  assert.deepEqual(subagentActivitiesForView([], messages), [stored])
})

void test('live activity overrides the persisted snapshot with the same id', () => {
  const historical = activity({ status: 'queued', phase: 'queued', updatedAt: 2 })
  const live = activity({ status: 'running', phase: 'using-tool', updatedAt: 5 })
  const messages: ChatMessage[] = [{ id: 'assistant-1', role: 'assistant', content: '', createdAt: 3, toolCalls: [{ toolName: 'Agent', input: {}, status: 'done', metadata: { subagentActivity: historical } }] }]
  assert.deepEqual(subagentActivitiesForView([live], messages), [live])
})

void test('rejects malformed activity metadata', () => {
  assert.equal(parseSubagentActivity({ id: 'bad', status: 'running' }), null)
})
