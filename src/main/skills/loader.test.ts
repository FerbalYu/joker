import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { discoverSkills, parseSkillFile } from './loader'

void test('parses external Skills with BOM, CRLF, and folder-id fallback', () => {
  const root = mkdtempSync(join(tmpdir(), 'joker-skills-'))
  try {
    const skillDir = join(root, 'external-qa')
    mkdirSync(skillDir)
    const skillPath = join(skillDir, 'SKILL.md')
    writeFileSync(skillPath, '\uFEFF---\r\nname: External QA\r\ndescription: Browser checks\r\n---\r\nUse the browser.\r\n', 'utf8')

    const skill = parseSkillFile(skillPath, 'external', 'external-qa')
    assert.equal(skill.id, 'external-qa')
    assert.equal(skill.source, 'external')
    assert.equal(skill.trusted, false)
    assert.equal(skill.instructions, 'Use the browser.')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

void test('discovers external Skills without changing their files', () => {
  const root = mkdtempSync(join(tmpdir(), 'joker-skills-'))
  try {
    const skillDir = join(root, 'safe-skill')
    mkdirSync(skillDir)
    const skillPath = join(skillDir, 'SKILL.md')
    const original = '---\nid: safe-skill\nname: Safe Skill\ndescription: Test\n---\nDo not execute scripts.\n'
    writeFileSync(skillPath, original, 'utf8')

    const skills = discoverSkills(root, 'external')
    assert.equal(skills.length, 1)
    assert.equal(skills[0].id, 'safe-skill')
    assert.equal(readFileSync(skillPath, 'utf8'), original)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
