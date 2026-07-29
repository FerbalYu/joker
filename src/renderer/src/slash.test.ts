import test from 'node:test'
import assert from 'node:assert/strict'
import { findSlashToken, filterSkills } from './slash'

const skills = [
  { id: 'docx', name: 'Document', description: 'Create documents', source: 'external', instructions: '', allowedMcpTools: [] as string[], enabled: true, trusted: true },
  { id: 'frontend-qa', name: 'Frontend QA', description: 'Check UI', source: 'external', instructions: '', allowedMcpTools: [] as string[], enabled: true, trusted: true },
  { id: 'disabled', name: 'Disabled', description: 'Not available', source: 'external', instructions: '', allowedMcpTools: [] as string[], enabled: false, trusted: true },
  { id: 'untrusted', name: 'Untrusted', description: 'Not trusted', source: 'user', instructions: '', allowedMcpTools: [] as string[], enabled: true, trusted: false }
] as const

void test('findSlashToken detects the command at the caret', () => {
  assert.deepEqual(findSlashToken('/doc', 4), { start: 0, end: 4, query: 'doc' })
  assert.deepEqual(findSlashToken('please /doc', 11), { start: 7, end: 11, query: 'doc' })
  assert.equal(findSlashToken('https://example.com', 19), null)
})

void test('filterSkills searches id, name, and description', () => {
  assert.deepEqual(filterSkills(skills, 'front').map((skill) => skill.id), ['frontend-qa'])
  assert.deepEqual(filterSkills(skills, 'document').map((skill) => skill.id), ['docx'])
})

void test('filterSkills excludes disabled and untrusted skills', () => {
  assert.deepEqual(
    filterSkills(skills, '').map((skill) => skill.id),
    ['docx', 'frontend-qa']
  )
})
