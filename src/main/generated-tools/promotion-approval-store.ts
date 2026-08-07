import { join } from 'node:path'

import type { GeneratedToolPromotionApprovalReceipt } from '../../shared/generated-tools'
import { canonicalGeneratedToolJson, parseGeneratedToolPromotionApprovalReceipt } from '../../shared/generated-tools-schema'
import { readJsonWithBackupStrict, updateJsonWithBackupStrict } from '../store/atomic-json'
import { generatedToolsRoot } from './store'
import { ToolForgeCasError } from './registry'

interface ApprovalReceiptState {
  schemaVersion: 1
  revision: number
  receipts: GeneratedToolPromotionApprovalReceipt[]
}

function parseState(value: unknown): ApprovalReceiptState {
  if (!value || typeof value !== 'object') throw new Error('Invalid promotion approval receipt state')
  const candidate = value as Partial<ApprovalReceiptState>
  if (candidate.schemaVersion !== 1 || !Number.isInteger(candidate.revision) || !Array.isArray(candidate.receipts)) throw new Error('Invalid promotion approval receipt state')
  const receipts = candidate.receipts.map(parseGeneratedToolPromotionApprovalReceipt)
  if (new Set(receipts.map((item) => item.id)).size !== receipts.length) throw new Error('Promotion approval receipt ids must be unique')
  if (new Set(receipts.map((item) => item.promotionId)).size !== receipts.length) throw new Error('Promotion approval promotion ids must be unique')
  return { schemaVersion: 1, revision: candidate.revision as number, receipts }
}

function initialState(): ApprovalReceiptState {
  return { schemaVersion: 1, revision: 0, receipts: [] }
}

export function getPromotionApprovalReceiptPath(jokerHome: string): string {
  return join(generatedToolsRoot(jokerHome), 'promotion-approvals.json')
}

export function readPromotionApprovalReceipts(jokerHome: string): ApprovalReceiptState {
  return readJsonWithBackupStrict(getPromotionApprovalReceiptPath(jokerHome), parseState) ?? initialState()
}

function isTrustedUpgrade(existing: GeneratedToolPromotionApprovalReceipt, replacement: GeneratedToolPromotionApprovalReceipt): boolean {
  if (existing.schemaVersion !== 1 || replacement.schemaVersion !== 2) return false
  return existing.id === replacement.id
    && existing.promotionId === replacement.promotionId
    && existing.jobId === replacement.jobId
    && existing.toolId === replacement.toolId
    && existing.candidateId === replacement.candidateId
    && existing.candidateFingerprint === replacement.candidateFingerprint
    && existing.validationReportId === replacement.validationReportId
    && existing.policyInputHash === replacement.policyInputHash
    && existing.sessionId === replacement.sessionId
    && existing.runId === replacement.runId
}

export function writePromotionApprovalReceipt(jokerHome: string, receipt: GeneratedToolPromotionApprovalReceipt): GeneratedToolPromotionApprovalReceipt {
  const parsed = parseGeneratedToolPromotionApprovalReceipt(receipt)
  let result = parsed
  updateJsonWithBackupStrict(getPromotionApprovalReceiptPath(jokerHome), parseState, initialState, (current) => {
    const existingIndex = current.receipts.findIndex((item) => item.id === parsed.id || item.promotionId === parsed.promotionId)
    const existing = existingIndex >= 0 ? current.receipts[existingIndex] : undefined
    if (existing) {
      if (canonicalGeneratedToolJson(existing) === canonicalGeneratedToolJson(parsed)) {
        result = existing
        return current
      }
      if (isTrustedUpgrade(existing, parsed)) {
        result = parsed
        return {
          schemaVersion: 1 as const,
          revision: current.revision + 1,
          receipts: current.receipts.map((item, index) => index === existingIndex ? parsed : item)
        }
      }
      throw new ToolForgeCasError('Promotion approval receipt identity already exists with different content')
    }
    result = parsed
    return { schemaVersion: 1 as const, revision: current.revision + 1, receipts: [...current.receipts, parsed] }
  })
  return result
}

export function isAuthorizingPromotionApprovalReceipt(receipt: GeneratedToolPromotionApprovalReceipt | null): receipt is Extract<GeneratedToolPromotionApprovalReceipt, { schemaVersion: 2 }> {
  return receipt?.schemaVersion === 2
}

export function readPromotionApprovalReceipt(jokerHome: string, promotionId: string): GeneratedToolPromotionApprovalReceipt | null {
  return readPromotionApprovalReceipts(jokerHome).receipts.find((item) => item.promotionId === promotionId) ?? null
}
