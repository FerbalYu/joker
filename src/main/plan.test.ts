import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPlanTools, normalizeChatIntent, PLAN_TOOL_NAMES } from './plan'

void test('plan tools are the explicit least-privilege inspection and TodoWrite allowlist', () => {
  const names = buildPlanTools().map((tool) => tool.name)
  assert.deepEqual(names, [...PLAN_TOOL_NAMES])
  for (const excluded of ['Write', 'Edit', 'Bash', 'Agent', 'WebSearch', 'WebRead', 'GenerateImage', 'GitBranch']) {
    assert.equal((names as string[]).includes(excluded), false)
  }
  assert.ok(names.includes('Read'))
  assert.ok(names.includes('Grep'))
  assert.ok(names.includes('Glob'))
  assert.ok(names.includes('GitStatus'))
  assert.ok(names.includes('GitDiff'))
  assert.ok(names.includes('GitLog'))
  assert.ok(names.includes('TodoWrite'))
})

void test('chat intent accepts only plan and visibly rejects unknown values', () => {
  assert.equal(normalizeChatIntent(undefined), undefined)
  assert.equal(normalizeChatIntent('plan'), 'plan')
  assert.throws(() => normalizeChatIntent('compact'), /Invalid chat intent/)
  assert.throws(() => normalizeChatIntent('PLAN'), /Invalid chat intent/)
  assert.throws(() => normalizeChatIntent(null), /Invalid chat intent/)
})
