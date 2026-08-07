import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isAuthorizingPromotionApprovalReceipt, readPromotionApprovalReceipt, writePromotionApprovalReceipt } from './promotion-approval-store'

const base = {
  id: 'approval-promotion-1',
  promotionId: 'promotion-1',
  jobId: 'job-1',
  toolId: 'tool-1',
  candidateId: 'candidate-1',
  candidateFingerprint: 'a'.repeat(64),
  validationReportId: 'report-1',
  policyInputHash: 'b'.repeat(64),
  sessionId: 'session-1',
  runId: 'run-1',
  approvedAt: 10,
  revision: 0
}

void test('legacy v1 promotion receipts remain readable but are not authorizing', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-promotion-approval-'))
  try {
    writePromotionApprovalReceipt(home, {
      schemaVersion: 1,
      ...base,
      windowId: 17,
      approved: true,
      approvalMode: 'full-auto'
    })
    const receipt = readPromotionApprovalReceipt(home, 'promotion-1')
    assert.equal(receipt?.schemaVersion, 1)
    assert.equal(isAuthorizingPromotionApprovalReceipt(receipt), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

void test('trusted v2 promotion receipts are authorizing and sender-bound', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-promotion-approval-'))
  try {
    writePromotionApprovalReceipt(home, {
      schemaVersion: 2,
      ...base,
      requestId: 'request-1',
      requestHash: 'c'.repeat(64),
      webContentsId: 17
    })
    const receipt = readPromotionApprovalReceipt(home, 'promotion-1')
    assert.equal(isAuthorizingPromotionApprovalReceipt(receipt), true)
    if (receipt?.schemaVersion === 2) {
      assert.equal(receipt.webContentsId, 17)
      assert.equal(receipt.requestId, 'request-1')
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
