import test from 'node:test'
import assert from 'node:assert/strict'

import { selectedSessionGenerationMatches } from './selected-session-generation'

void test('selected session generation accepts only the exact session and generation', () => {
  const token = { sessionId: 'session-a', generation: 4 }
  assert.equal(selectedSessionGenerationMatches(token, 'session-a', 4), true)
  assert.equal(selectedSessionGenerationMatches(token, 'session-b', 4), false)
  assert.equal(selectedSessionGenerationMatches(token, 'session-a', 5), false)
  assert.equal(selectedSessionGenerationMatches(token, null, 4), false)
})
