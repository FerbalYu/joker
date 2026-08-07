import test from 'node:test'
import assert from 'node:assert/strict'
import type { SessionActivitySummary } from '@shared/types'
import { getSidebarSessionStatus } from './sidebar-session-status'

const activity = (overrides: Partial<SessionActivitySummary> = {}): SessionActivitySummary => ({
  status: 'idle',
  unread: false,
  terminalRevision: 0,
  seenTerminalRevision: 0,
  pendingApprovalCount: 0,
  ...overrides
})

void test('sidebar status icon precedence favors awaiting user over unread terminal state', () => {
  assert.deepEqual(getSidebarSessionStatus(activity({
    status: 'awaiting-user',
    unread: true,
    pendingApprovalCount: 2,
    livePhase: 'awaiting-approval'
  })), {
    dataStatus: 'awaiting-user',
    icon: 'shield-alert',
    tone: 'amber',
    spin: false,
    labelKey: 'sidebar.status.awaitingUserCount',
    labelParams: { count: 2 }
  })
})

void test('running sessions use the spinning accent icon and localized phase key', () => {
  assert.deepEqual(getSidebarSessionStatus(activity({
    status: 'running',
    livePhase: 'running-tools'
  })), {
    dataStatus: 'running',
    icon: 'loader',
    tone: 'accent',
    spin: true,
    labelKey: 'sidebar.status.running.runningTools'
  })
})

void test('only unread failed and completed sessions receive terminal icons', () => {
  assert.equal(getSidebarSessionStatus(activity({ status: 'failed', unread: true })).icon, 'circle-x')
  assert.equal(getSidebarSessionStatus(activity({ status: 'failed', unread: true })).tone, 'red')
  assert.equal(getSidebarSessionStatus(activity({ status: 'completed', unread: true })).icon, 'circle-check')
  assert.equal(getSidebarSessionStatus(activity({ status: 'completed', unread: true })).tone, 'green')

  assert.equal(getSidebarSessionStatus(activity({ status: 'failed', unread: false })).icon, 'message-square')
  assert.equal(getSidebarSessionStatus(activity({ status: 'completed', unread: false })).icon, 'message-square')
})

void test('interrupted sessions retain amber attention while other states fall back', () => {
  assert.deepEqual(getSidebarSessionStatus(activity({ status: 'interrupted' })), {
    dataStatus: 'interrupted',
    icon: 'message-square-warning',
    tone: 'amber',
    spin: false,
    labelKey: 'sidebar.status.interrupted'
  })

  for (const status of ['idle', 'cancelled'] as const) {
    const result = getSidebarSessionStatus(activity({ status }))
    assert.equal(result.icon, 'message-square')
    assert.equal(result.tone, 'muted')
    assert.equal(result.dataStatus, status)
  }
})
