import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_SELECTED_SLASH_SKILLS,
  filterSlashCommands,
  insertSlashToken,
  nativeCommandItems,
  parseNativeSlashCommand,
  removeSlashToken,
  skillCommandItems,
  type SlashCommandItem
} from './slash-commands'

const skills = [
  { id: 'docx', name: 'Documents', description: 'Create office documents', source: 'external', instructions: '', allowedMcpTools: [] as string[], enabled: true, trusted: true, trustState: 'trusted' },
  { id: 'frontend-qa', name: 'Frontend QA', description: 'Check interface regressions', source: 'builtin', instructions: '', allowedMcpTools: [] as string[], enabled: true, trusted: true, trustState: 'trusted' },
  { id: 'disabled', name: 'Disabled', description: 'Unavailable', source: 'user', instructions: '', allowedMcpTools: [] as string[], enabled: false, trusted: false, trustState: 'untrusted' },
  { id: 'changed', name: 'Changed', description: 'Needs renewed enablement', source: 'external', instructions: '', allowedMcpTools: [] as string[], enabled: false, trusted: false, trustState: 'changed' }
] as const

void test('insertSlashToken respects boundaries and replaces selections', () => {
  assert.deepEqual(insertSlashToken('', 0, 0), { text: '/', caret: 1, token: { start: 0, end: 1, query: '' } })
  assert.deepEqual(insertSlashToken('hello', 5, 5), { text: 'hello /', caret: 7, token: { start: 6, end: 7, query: '' } })
  assert.deepEqual(insertSlashToken('hello world', 6, 11), { text: 'hello /', caret: 7, token: { start: 6, end: 7, query: '' } })
  assert.deepEqual(insertSlashToken('hello ', 6, 6), { text: 'hello /', caret: 7, token: { start: 6, end: 7, query: '' } })
})

void test('removeSlashToken removes only the active command and keeps suffix text', () => {
  assert.deepEqual(removeSlashToken('before /doc after /literal', { start: 7, end: 11, query: 'doc' }), {
    text: 'before  after /literal',
    caret: 7
  })
})

void test('native command parser extracts Goal lifecycle actions and ordinary arguments', () => {
  assert.deepEqual(parseNativeSlashCommand('/goal'), { command: 'goal', action: 'inspect', argument: '' })
  assert.deepEqual(parseNativeSlashCommand('/goal ship the renderer'), { command: 'goal', action: 'create', argument: 'ship the renderer' })
  assert.deepEqual(parseNativeSlashCommand('/goal replace ship safely'), { command: 'goal', action: 'replace', argument: 'ship safely' })
  assert.deepEqual(parseNativeSlashCommand('/goal pause'), { command: 'goal', action: 'pause', argument: '' })
  assert.deepEqual(parseNativeSlashCommand('/goal resume'), { command: 'goal', action: 'resume', argument: '' })
  assert.deepEqual(parseNativeSlashCommand('/goal clear'), { command: 'goal', action: 'clear', argument: '' })
  assert.equal(parseNativeSlashCommand('/goal replace'), null)
  assert.equal(parseNativeSlashCommand('/goal pause later'), null)
  assert.deepEqual(parseNativeSlashCommand('  /plan\nwrite tests  '), { command: 'plan', argument: 'write tests' })
  assert.deepEqual(parseNativeSlashCommand('/compact'), { command: 'compact', argument: '' })
  assert.equal(parseNativeSlashCommand('please /goal ship'), null)
  assert.equal(parseNativeSlashCommand('/model gpt-4o'), null)
})

void test('native commands are exactly goal, plan, compact in stable order', () => {
  const items = nativeCommandItems({
    labels: { goal: { description: 'Goal' }, plan: { description: 'Plan' }, compact: { description: 'Compact' } },
    unavailableReason: 'Unavailable',
    busyReason: 'Busy',
    goalAvailable: true,
    planAvailable: true,
    compactAvailable: true,
    busy: false
  })
  assert.deepEqual(items.map((item) => item.id), ['native:goal', 'native:plan', 'native:compact'])
  assert.equal(items.every((item) => item.section === 'commands' && item.action === 'select-native' && !item.disabled), true)
})

void test('unwired native commands remain visible and explain why they are disabled', () => {
  const items = nativeCommandItems({
    labels: { goal: { description: 'Goal' }, plan: { description: 'Plan' }, compact: { description: 'Compact' } },
    unavailableReason: 'Not wired',
    busyReason: 'Busy',
    goalAvailable: false,
    planAvailable: false,
    compactAvailable: false,
    busy: false
  })
  assert.equal(items.every((item) => item.disabled && item.disabledReason === 'Not wired'), true)
})

void test('command filtering searches labels, descriptions, metadata, and keywords', () => {
  const items: SlashCommandItem[] = [
    { id: 'native:goal', section: 'commands', action: 'select-native', nativeCommand: 'goal', label: '/goal', description: 'Set objective', keywords: ['outcome'] },
    { id: 'skill:docx', section: 'skills', action: 'select-skill', label: '/docx', description: 'Create documents', meta: 'External', value: 'docx' }
  ]
  assert.deepEqual(filterSlashCommands(items, 'outcome').map((item) => item.id), ['native:goal'])
  assert.deepEqual(filterSlashCommands(items, 'external').map((item) => item.id), ['skill:docx'])
  assert.deepEqual(filterSlashCommands(items, 'documents').map((item) => item.id), ['skill:docx'])
})

void test('skill commands include unavailable skills disabled, exclude selected skills, and enforce the limit', () => {
  const labels = { limitReached: 'Limit', disabled: 'Disabled', changed: 'Changed' }
  const items = skillCommandItems(skills, ['docx'], labels)
  assert.deepEqual(items.map((item) => item.value), ['frontend-qa', 'disabled', 'changed'])
  assert.equal(items.find((item) => item.value === 'frontend-qa')?.disabled, false)
  assert.equal(items.find((item) => item.value === 'disabled')?.disabledReason, 'Disabled')
  assert.equal(items.find((item) => item.value === 'changed')?.disabledReason, 'Changed')

  const selected = Array.from({ length: MAX_SELECTED_SLASH_SKILLS }, (_, index) => `selected-${index}`)
  const limited = skillCommandItems(skills, selected, labels)
  assert.equal(limited.filter((item) => ['docx', 'frontend-qa'].includes(item.value ?? '')).every((item) => item.disabledReason === 'Limit'), true)
  assert.equal(limited.find((item) => item.value === 'disabled')?.disabledReason, 'Disabled')
})
