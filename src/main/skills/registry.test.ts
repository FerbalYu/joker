import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AppConfig } from '../../shared/types'
import { normalizeConfig } from '../store/config'
import { SkillRegistry } from './registry'

function providerConfig(): AppConfig {
  return normalizeConfig({
    providers: [{ id: 'p', name: 'P', type: 'openai', models: [{ id: 'm', name: 'm', enabled: true }], currentModelId: 'm' }],
    activeProviderId: 'p'
  })
}

function writeSkill(root: string, id: string, instructions: string): void {
  const directory = join(root, id)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'SKILL.md'), `---\nid: ${id}\nname: ${id}\ndescription: Test Skill\n---\n${instructions}\n`, 'utf8')
}

function createRoots(root: string): { builtin: string; external: string; user: string } {
  const roots = {
    builtin: join(root, 'builtin'),
    external: join(root, 'external'),
    user: join(root, 'user')
  }
  mkdirSync(roots.builtin)
  mkdirSync(roots.external)
  mkdirSync(roots.user)
  return roots
}

void test('registry enforces enabled equals trusted for every Skill state', () => {
  const root = mkdtempSync(join(tmpdir(), 'joker-skill-registry-'))
  try {
    const roots = createRoots(root)
    writeSkill(roots.user, 'user-skill', 'Use the safe workflow.')

    let config = providerConfig()
    const registry = new SkillRegistry({
      loadConfig: () => config,
      saveConfig: (next) => { config = normalizeConfig(next) },
      roots: () => roots
    })

    let skill = registry.list()[0]
    assert.equal(skill.enabled, false)
    assert.equal(skill.trusted, false)
    assert.equal(skill.trustState, 'untrusted')
    assert.deepEqual(registry.getActive(), [])
    assert.deepEqual(registry.getInvokableByIds(['user-skill']), [])

    const enabled = registry.setEnabled('user-skill', true)
    assert.equal(enabled.enabled, true)
    assert.equal(enabled.trusted, true)
    assert.equal(enabled.trustState, 'trusted')
    assert.equal(config.trustedSkills?.[0]?.fingerprint, enabled.fingerprint)
    assert.equal(registry.getActive()[0]?.id, 'user-skill')
    assert.equal(registry.getInvokableByIds(['user-skill'])[0]?.id, 'user-skill')

    const disabled = registry.setEnabled('user-skill', false)
    assert.equal(disabled.enabled, false)
    assert.equal(disabled.trusted, false)
    assert.equal(disabled.trustState, 'untrusted')
    assert.deepEqual(config.trustedSkills, [])
    assert.deepEqual(registry.getActive(), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

void test('legacy trust actions are aliases for enable and disable', () => {
  const root = mkdtempSync(join(tmpdir(), 'joker-skill-registry-'))
  try {
    const roots = createRoots(root)
    writeSkill(roots.external, 'external-skill', 'External instructions.')

    let config = providerConfig()
    const registry = new SkillRegistry({
      loadConfig: () => config,
      saveConfig: (next) => { config = normalizeConfig(next) },
      roots: () => roots
    })

    assert.equal(registry.trust('external-skill').enabled, true)
    assert.equal(registry.revokeTrust('external-skill').enabled, false)
    assert.deepEqual(config.trustedSkills, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

void test('registry automatically disables a Skill when its content changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'joker-skill-registry-'))
  try {
    const roots = createRoots(root)
    writeSkill(roots.external, 'external-skill', 'Original instructions.')

    let config = providerConfig()
    const registry = new SkillRegistry({
      loadConfig: () => config,
      saveConfig: (next) => { config = normalizeConfig(next) },
      roots: () => roots
    })
    const enabled = registry.setEnabled('external-skill', true)
    assert.equal(enabled.trustState, 'trusted')

    writeSkill(roots.external, 'external-skill', 'Changed instructions.')
    const changed = registry.list()[0]
    assert.equal(changed.enabled, false)
    assert.equal(changed.trusted, false)
    assert.equal(changed.trustState, 'changed')
    assert.deepEqual(registry.getActive(), [])
    assert.deepEqual(registry.getInvokableByIds(['external-skill']), [])

    const reenabled = registry.setEnabled('external-skill', true)
    assert.equal(reenabled.enabled, true)
    assert.equal(reenabled.trusted, true)
    assert.equal(reenabled.trustState, 'trusted')
    assert.notEqual(reenabled.fingerprint, enabled.fingerprint)
    assert.equal(config.trustedSkills?.[0]?.fingerprint, reenabled.fingerprint)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

void test('registry persists fingerprint-bound enablement across instances', () => {
  const root = mkdtempSync(join(tmpdir(), 'joker-skill-registry-'))
  try {
    const roots = createRoots(root)
    const configPath = join(root, 'config.json')
    writeSkill(roots.user, 'persisted-skill', 'Original instructions.')

    writeFileSync(configPath, JSON.stringify(providerConfig()), 'utf8')
    const load = (): AppConfig => normalizeConfig(JSON.parse(readFileSync(configPath, 'utf8')))
    const save = (next: AppConfig): void => writeFileSync(configPath, JSON.stringify(normalizeConfig(next)), 'utf8')
    const firstRegistry = new SkillRegistry({ loadConfig: load, saveConfig: save, roots: () => roots })
    firstRegistry.setEnabled('persisted-skill', true)

    const restoredRegistry = new SkillRegistry({ loadConfig: load, saveConfig: save, roots: () => roots })
    assert.equal(restoredRegistry.list()[0].enabled, true)
    assert.equal(restoredRegistry.list()[0].trusted, true)

    writeSkill(roots.user, 'persisted-skill', 'Changed instructions.')
    assert.equal(restoredRegistry.list()[0].trustState, 'changed')
    assert.equal(restoredRegistry.list()[0].enabled, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

void test('built-in Skills use the same fingerprint-bound enablement invariant', () => {
  const root = mkdtempSync(join(tmpdir(), 'joker-skill-registry-'))
  try {
    const roots = createRoots(root)
    writeSkill(roots.builtin, 'builtin-skill', 'Built-in instructions.')

    let config = providerConfig()
    const registry = new SkillRegistry({
      loadConfig: () => config,
      saveConfig: (next) => { config = normalizeConfig(next) },
      roots: () => roots
    })

    assert.equal(registry.list()[0].enabled, false)
    assert.equal(registry.setEnabled('builtin-skill', true).enabled, true)
    assert.equal(registry.setEnabled('builtin-skill', false).trusted, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
