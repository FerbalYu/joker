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

void test('localizeError explains execution contract failures in Chinese', () => {
  const value = localizeError('zh', 'Execution contract violation: this request required a real tool call, but the model returned only text. No action was performed.')
  assert.equal(value, '该请求必须真实调用工具，但模型只返回了文本。本轮没有执行任何操作。')
})

void test('localizeError translates common UI errors', () => {
  assert.equal(localizeError('zh', 'Session not found'), '会话不存在')
  assert.equal(localizeError('zh', 'File not found'), '文件不存在')
  assert.equal(localizeError('zh', 'Tool call was denied by user.'), '工具调用已被用户拒绝.')
})

void test('sidebar session status translations exist in both languages', () => {
  for (const language of ['zh', 'en'] as const) {
    for (const key of [
      'sidebar.renameConversation',
      'sidebar.deleteConversation',
      'sidebar.status.idle',
      'sidebar.status.running',
      'sidebar.status.running.starting',
      'sidebar.status.running.waitingModel',
      'sidebar.status.running.streamingText',
      'sidebar.status.running.runningTools',
      'sidebar.status.running.finalizing',
      'sidebar.status.awaitingUser',
      'sidebar.status.awaitingUserCount',
      'sidebar.status.completed',
      'sidebar.status.completedUnread',
      'sidebar.status.failed',
      'sidebar.status.failedUnread',
      'sidebar.status.cancelled',
      'sidebar.status.interrupted'
    ]) assert.notEqual(t(language, key, { count: 2 }), key)
  }
  assert.equal(t('zh', 'sidebar.status.awaitingUserCount', { count: 2 }), '等待你的操作（2 个待审批）')
  assert.equal(t('en', 'sidebar.status.awaitingUserCount', { count: 2 }), 'Waiting for your action (2 pending approvals)')
})

void test('send lifecycle translations exist in both languages', () => {
  for (const language of ['zh', 'en'] as const) {
    for (const key of [
      'message.saveFailed',
      'message.channelNotReady',
      'message.sessionNotReady',
      'message.sendBusy',
      'goal.saved',
      'goal.cleared',
      'goal.paused',
      'goal.pausing',
      'goal.resumed',
      'goal.empty',
      'goal.inspected',
      'goal.saveFailed',
      'detail.goal',
      'detail.goalRound',
      'detail.goalBudget',
      'detail.goalUsageUnlimited',
      'detail.goalPause',
      'detail.goalResume',
      'detail.goalClear',
      'detail.elapsed',
      'compact.running',
      'compact.success',
      'compact.unchanged',
      'compact.stale',
      'compact.failed',
      'plan.requiresTaskOrGoal'
    ]) assert.notEqual(t(language, key), key)
  }
  assert.equal(t('zh', 'detail.goalUsageUnlimited', { used: '1,234' }), '已用 1,234 Token')
  assert.equal(t('en', 'detail.goalUsageUnlimited', { used: '1,234' }), '1,234 tokens used')
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

void test('slash command UI translations describe only native intents and Skill availability', () => {
  for (const language of ['zh', 'en'] as const) {
    for (const key of [
      'input.openCommands',
      'input.commandsAndSkills',
      'input.commandsNoResults',
      'input.commandsNoResultsHint',
      'input.commandsNoSkills',
      'input.commandsLoadFailed',
      'input.selectedSkillsUnavailable',
      'input.commandGoalDescription',
      'input.commandPlanDescription',
      'input.commandCompactDescription',
      'input.commandUnavailableNotWired',
      'input.commandSkillLimit',
      'input.commandSkillDisabled',
      'input.commandSkillChanged',
      'input.removeCommand',
      'input.removeSkill',
      'input.commandGroup.commands',
      'input.commandGroup.skills'
    ]) assert.notEqual(t(language, key), key)
  }
  assert.equal(t('zh', 'input.commandGoalDescription'), '创建、查看、暂停、恢复、替换或清除自动执行 Goal')
  assert.equal(t('en', 'input.commandGoalDescription'), 'Create, inspect, pause, resume, replace, or clear an autonomous Goal')
})

void test('Skill enablement UI translations describe one fingerprint-bound state', () => {
  for (const language of ['zh', 'en'] as const) {
    for (const key of [
      'settings.skillsDescription',
      'settings.skillSafety',
      'settings.enableSkill',
      'settings.reenableSkill',
      'settings.disableSkill',
      'settings.skillChanged',
      'settings.skillChangedHint',
      'settings.skillEnableFailed'
    ]) assert.notEqual(t(language, key), key)
  }
  assert.match(t('zh', 'settings.skillsDescription'), /启用 Skill 即表示信任/)
  assert.doesNotMatch(t('zh', 'settings.skillsDescription'), /分别管理/)
  assert.doesNotMatch(t('en', 'settings.skillsDescription'), /managed separately/i)
})

void test('Generated Tools inventory and Workbench translations exist in both languages', () => {
  for (const language of ['zh', 'en'] as const) {
    for (const key of [
      'settings.section.generated-tools',
      'settings.generatedTools',
      'settings.generatedToolsDescription',
      'settings.generatedToolsEmpty',
      'toolforge.fullTrust',
      'toolforge.fullTrustNotGrantedHint',
      'toolforge.fullTrustGrantedHint',
      'toolforge.fullTrustGrant',
      'toolforge.fullTrustRevoke',
      'toolforge.fullTrustNoWorkspace',
      'toolforge.runtimeQualification',
      'toolforge.qualificationNotVerified',
      'toolforge.qualificationVerified',
      'toolforge.productState.manufacturing',
      'toolforge.productState.enabled',
      'toolforge.productState.disabled',
      'toolforge.productState.validation-failed',
      'toolforge.productState.waiting-permission',
      'toolforge.failedUpdateHint',
      'toolforge.waitingPermissionHint',
      'toolforge.enable',
      'toolforge.statusAndControls',
      'toolforge.modify',
      'toolforge.problems',
      'toolforge.advancedDiagnostics',
      'toolforge.executionApprovalRequired',
      'toolforge.executionUnavailable',
      'toolforge.workbench',
      'toolforge.overview',
      'toolforge.permissions',
      'toolforge.inputOutput',
      'toolforge.validation',
      'toolforge.versions',
      'toolforge.invocationHistory',
      'toolforge.status.available',
      'toolforge.status.changed',
      'toolforge.status.disabled',
      'toolforge.status.quarantined',
      'toolforge.status.missing',
      'toolforge.job.validating',
      'toolforge.outcome.succeeded'
    ]) assert.notEqual(t(language, key), key)
  }
  assert.doesNotMatch(t('zh', 'toolforge.qualificationVerified'), /L\d/)
  assert.doesNotMatch(t('en', 'toolforge.qualificationVerified'), /L\d/)
  assert.doesNotMatch(t('zh', 'settings.generatedToolsDescription'), /指纹|修订|报告|候选/)
  assert.doesNotMatch(t('en', 'settings.generatedToolsDescription'), /fingerprint|revision|report|candidate/i)
  assert.match(t('en', 'toolforge.fullTrustGrantedHint'), /canonical working folder/i)
  assert.match(t('zh', 'toolforge.fullTrustGrantedHint'), /规范化的工作文件夹/)
})

void test('generated tool enable approval copy is human-readable', () => {
  for (const language of ['zh', 'en'] as const) {
    for (const key of [
      'approval.description.generatedToolEnable',
      'approval.generatedTool',
      'approval.allowEnable',
      'approval.keepDisabled'
    ]) assert.notEqual(t(language, key), key)
    assert.notEqual(toolLabel(language, 'GeneratedToolEnable'), 'GeneratedToolEnable')
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
      'research.chart.xAxis',
      'research.chart.yAxis',
      'research.chart.type.bar',
      'research.chart.type.line',
      'research.chart.type.pie',
      'research.chart.type.scatter',
      'research.progress.synthesizing',
      'approval.description.researchWebAccess'
    ]) assert.notEqual(t(language, key), key)
    assert.notEqual(toolLabel(language, 'ResearchWebAccess'), 'ResearchWebAccess')
    assert.notEqual(toolLabel(language, 'PresentResearchReport'), 'PresentResearchReport')
  }
})

void test('sub-agent observability translations cover lifecycle and disclosure states', () => {
  for (const language of ['zh', 'en'] as const) {
    for (const key of [
      'detail.subagents',
      'subagent.title',
      'subagent.observableNotice',
      'subagent.noToolsYet',
      'subagent.result',
      'subagent.usageStepsOnly',
      'subagent.status.queued',
      'subagent.status.running',
      'subagent.status.completed',
      'subagent.status.failed',
      'subagent.status.cancelled',
      'subagent.phase.using-tool',
      'subagent.phase.finalizing'
    ]) assert.notEqual(t(language, key), key)
  }
})

void test('ToolCall lifecycle and Spill translations exist in both languages', () => {
  const keys = [
    'tool.status.proposed',
    'tool.status.proposedDetail',
    'tool.status.awaitingApproval',
    'tool.status.awaitingApprovalDetail',
    'tool.status.denied',
    'tool.status.deniedDetail',
    'tool.status.outcomeUnknown',
    'tool.status.outcomeUnknownDetail',
    'tool.group.proposed',
    'tool.group.awaitingApproval',
    'tool.group.outcomeUnknown',
    'tool.spill.preview',
    'tool.spill.fullResult',
    'tool.spill.loadMore',
    'tool.spill.loading',
    'tool.spill.retry',
    'tool.spill.error',
    'tool.spill.eof',
    'tool.spill.progress',
    'tool.spill.unavailable'
  ]
  for (const language of ['zh', 'en'] as const) {
    for (const key of keys) assert.notEqual(t(language, key, { count: 2, loaded: '1 KB', total: '2 KB', error: 'offline' }), key)
  }
  assert.match(t('zh', 'tool.status.outcomeUnknownDetail'), /重试前请先核实/)
  assert.match(t('en', 'tool.status.outcomeUnknownDetail'), /before retrying/i)
})
