import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveExecutionContract } from './execution-contract'

const tools = ['ContextRetrieve', 'Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'TodoWrite', 'WebSearch', 'WebRead', 'GitStatus', 'GitDiff']

function resolve(userText: string, workspacePath: string | null = 'E:\\workspace') {
  return resolveExecutionContract({
    userText,
    runMode: 'chat',
    workspacePath,
    availableToolNames: tools
  })
}

void test('short continuation directives require a substantive tool call', () => {
  const contract = resolve('进行下一步')
  assert.equal(contract?.taskKind, 'continuation')
  assert.equal(contract?.requireToolCall, true)
  assert.ok(contract?.activeToolNames.includes('Bash'))
  assert.ok(!contract?.activeToolNames.includes('TodoWrite'))
})

void test('workspace change and inspection requests use matching tool groups', () => {
  assert.equal(resolve('修复这个问题')?.taskKind, 'workspace-change')
  assert.equal(resolve('补上。免得模型光说不做')?.taskKind, 'workspace-change')
  assert.equal(resolve('检查一下当前进度')?.taskKind, 'workspace-inspection')
  assert.equal(resolve('运行最终回归')?.taskKind, 'workspace-validation')
})

void test('questions and ordinary conversation do not force tools', () => {
  assert.equal(resolve('你是没有工具还是什么回事？'), null)
  assert.equal(resolve('为什么模型没有调用工具？'), null)
  assert.equal(resolve('解释一下 toolChoice 的作用'), null)
})

void test('workspace actions are not forced when no workspace is selected', () => {
  assert.equal(resolve('修复这个问题', null), null)
})

void test('plan intent requires TodoWrite even without a workspace', () => {
  const contract = resolveExecutionContract({
    userText: '给我一个计划',
    runMode: 'chat',
    intent: 'plan',
    workspacePath: null,
    availableToolNames: tools
  })
  assert.deepEqual(contract?.activeToolNames, ['TodoWrite'])
})

void test('web research uses web tools without requiring a workspace', () => {
  const contract = resolve('联网搜索一下最新资料', null)
  assert.equal(contract?.taskKind, 'web-research')
  assert.deepEqual(contract?.activeToolNames, ['WebSearch', 'WebRead'])
})

void test('workspace search stays on local inspection tools', () => {
  const contract = resolve('搜索一下项目里的执行契约')
  assert.equal(contract?.taskKind, 'workspace-inspection')
  assert.ok(contract?.activeToolNames.includes('Grep'))
  assert.ok(!contract?.activeToolNames.includes('WebSearch'))
})
