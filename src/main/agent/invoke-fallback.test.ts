import test from 'node:test'
import assert from 'node:assert/strict'
import { parseInvokeToolCall } from './invoke-fallback'

void test('parses bare single-token values and coerces numbers', () => {
  assert.deepEqual(
    parseInvokeToolCall('invoke ToolSearch with query is find-skills limit is 10'),
    { toolName: 'ToolSearch', input: { query: 'find-skills', limit: 10 } }
  )
})

void test('parses a JSON array value', () => {
  assert.deepEqual(
    parseInvokeToolCall('invoke tool TodoWrite with todos is [{"content":"写报告"},{"content":"发邮件"}]'),
    { toolName: 'TodoWrite', input: { todos: [{ content: '写报告' }, { content: '发邮件' }] } }
  )
})

void test('parses a JSON object value with a nested string', () => {
  assert.deepEqual(
    parseInvokeToolCall('invoke GenMap with input is {"mode": "side_scroll", "size": 10} expected is {"output": "glb"}'),
    { toolName: 'GenMap', input: { input: { mode: 'side_scroll', size: 10 }, expected: { output: 'glb' } } }
  )
})

void test('parses a leading Chinese bare value', () => {
  assert.deepEqual(
    parseInvokeToolCall('invoke ToolForgeStart with goal is 搭建项目 is id is project-1'),
    { toolName: 'ToolForgeStart', input: { goal: '搭建项目', id: 'project-1' } }
  )
})

void test('returns null for plain prose without an invoke header', () => {
  assert.equal(parseInvokeToolCall('我来帮你规划今天的工作。'), null)
  assert.equal(parseInvokeToolCall(''), null)
})
