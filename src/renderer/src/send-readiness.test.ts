import test from 'node:test'
import assert from 'node:assert/strict'
import { canStartChatSend, sendUnavailableReason } from './send-readiness'

const ready = { sessionId: 'session-a', sessionLoading: false, streaming: false, starting: false, portReady: true }

void test('allows send only when session and stream channel are ready', () => {
  assert.equal(canStartChatSend(ready), true)
  assert.equal(canStartChatSend({ ...ready, portReady: false }), false)
  assert.equal(canStartChatSend({ ...ready, sessionLoading: true }), false)
  assert.equal(canStartChatSend({ ...ready, starting: true }), false)
})

void test('returns a stable user-facing reason for rejected sends', () => {
  assert.equal(sendUnavailableReason({ ...ready, sessionId: null }), 'session')
  assert.equal(sendUnavailableReason({ ...ready, starting: true }), 'busy')
  assert.equal(sendUnavailableReason({ ...ready, portReady: false }), 'channel')
  assert.equal(sendUnavailableReason(ready), null)
})
