import test from 'node:test'
import assert from 'node:assert/strict'
import { localizeError, t, toolLabel } from './i18n'

void test('localizeError translates AI SDK network errors to Chinese', () => {
  const value = localizeError('zh', 'AI_RetryError: Failed after 3 attempts. Last error: AI_APICallError: Cannot connect to API: bad port')
  assert.equal(value, '重试错误：重试 3 次后仍然失败。最后一次错误：API 调用错误：无法连接到 API：端口号无效')
})

void test('localizeError preserves English when English is selected', () => {
  const value = localizeError('en', 'AI_APICallError: Cannot connect to API: bad port')
  assert.equal(value, 'AI_APICallError: Cannot connect to API: bad port')
})

void test('localizeError translates common UI errors', () => {
  assert.equal(localizeError('zh', 'Session not found'), '会话不存在')
  assert.equal(localizeError('zh', 'File not found'), '文件不存在')
  assert.equal(localizeError('zh', 'Tool call was denied by user.'), '工具调用已被用户拒绝.')
})

void test('send lifecycle translations exist in both languages', () => {
  for (const language of ['zh', 'en'] as const) {
    for (const key of [
      'message.saveFailed',
      'message.channelNotReady',
      'message.sessionNotReady',
      'message.sendBusy'
    ]) assert.notEqual(t(language, key), key)
  }
})

void test('context optimization UI translations exist in both languages', () => {
  for (const language of ['zh', 'en'] as const) {
    for (const key of [
      'context.mode.legacy',
      'context.mode.observe',
      'context.mode.v2',
      'context.mode.disabled',
      'context.latestTransform',
      'context.retrievable',
      'context.summaryCost',
      'context.estimatedNetSaved',
      'context.retrievalCount',
      'context.errorValue',
      'settings.contextOptimization',
      'settings.contextOptimizationDisable',
      'settings.contextOptimizationModeHint.observe'
    ]) assert.notEqual(t(language, key), key)
  }
})

void test('research mode, approval, report and progress translations exist in both languages', () => {
  for (const language of ['zh', 'en'] as const) {
    for (const key of [
      'research.mode.research',
      'research.mode.publicWebOnly',
      'research.report.invalid',
      'research.report.download',
      'research.report.saving',
      'research.report.saved',
      'research.report.saveFailed',
      'research.sources',
      'research.chart.data',
      'research.progress.synthesizing',
      'approval.description.researchWebAccess'
    ]) assert.notEqual(t(language, key), key)
    assert.notEqual(toolLabel(language, 'ResearchWebAccess'), 'ResearchWebAccess')
    assert.notEqual(toolLabel(language, 'PresentResearchReport'), 'PresentResearchReport')
  }
})
