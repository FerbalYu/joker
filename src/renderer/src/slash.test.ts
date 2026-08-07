import test from 'node:test'
import assert from 'node:assert/strict'
import { findSlashToken, filterSkills } from './slash'

const skills = [
  { id: 'docx', name: 'Document', description: 'Create documents', source: 'external', instructions: '', allowedMcpTools: [] as string[], enabled: true, trusted: true, trustState: 'trusted' },
  { id: 'frontend-qa', name: 'Frontend QA', description: 'Check UI', source: 'external', instructions: '', allowedMcpTools: [] as string[], enabled: true, trusted: true, trustState: 'trusted' },
  { id: 'disabled', name: 'Disabled', description: 'Not available', source: 'external', instructions: '', allowedMcpTools: [] as string[], enabled: false, trusted: false, trustState: 'untrusted' },
  { id: 'changed', name: 'Changed', description: 'Content changed', source: 'user', instructions: '', allowedMcpTools: [] as string[], enabled: false, trusted: false, trustState: 'changed' }
] as const

void test('findSlashToken detects the command at the caret', () => {
  assert.deepEqual(findSlashToken('/', 1), { start: 0, end: 1, query: '' })
  assert.deepEqual(findSlashToken('/doc', 4), { start: 0, end: 4, query: 'doc' })
  assert.deepEqual(findSlashToken('please /doc', 11), { start: 7, end: 11, query: 'doc' })
  assert.deepEqual(findSlashToken('first\n/frontend-qa trailing', 18), { start: 6, end: 18, query: 'frontend-qa' })
  assert.equal(findSlashToken('hello,/doc', 10), null)
  assert.equal(findSlashToken('https://example.com', 19), null)
})

void test('filterSkills searches id, name, and description', () => {
  assert.deepEqual(filterSkills(skills, 'front').map((skill) => skill.id), ['frontend-qa'])
  assert.deepEqual(filterSkills(skills, 'document').map((skill) => skill.id), ['docx'])
})

void test('filterSkills keeps discovered disabled and changed skills visible', () => {
  assert.deepEqual(
    filterSkills(skills, '').map((skill) => skill.id),
    ['docx', 'frontend-qa', 'disabled', 'changed']
  )
})
