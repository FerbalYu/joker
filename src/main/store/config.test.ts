import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeConfig, preserveSkillConfigState, hasToolForgeFullTrust, setToolForgeFullTrust } from './config'
import { DEFAULT_MAX_CONTEXT_TOKENS } from '../../shared/types'

void test('normalizeConfig adds and validates model context limits', () => {
  const config = normalizeConfig({
    providers: [{ id: 'p', name: 'P', type: 'openai', models: [
      { id: 'good', name: 'good', enabled: true, maxContextTokens: 4096 },
      { id: 'bad', name: 'bad', enabled: true, maxContextTokens: -1 }
    ], currentModelId: 'good' }],
    activeProviderId: 'p'
  })
  assert.equal(config.providers[0].models[0].maxContextTokens, 4096)
  assert.equal(config.providers[0].models[1].maxContextTokens, DEFAULT_MAX_CONTEXT_TOKENS)
})

void test('normalizeConfig stores one canonical fingerprint-bound Skill state', () => {
  const config = normalizeConfig({
    providers: [{ id: 'p', name: 'P', type: 'openai', models: [{ id: 'm', name: 'm', enabled: true }], currentModelId: 'm' }],
    activeProviderId: 'p',
    trustedSkills: [{ id: 'enabled-skill', fingerprint: 'a'.repeat(64) }]
  })
  assert.equal(config.skillStateVersion, 1)
  assert.equal(config.disabledSkills, undefined)
  assert.deepEqual(config.trustedSkills, [{ id: 'enabled-skill', fingerprint: 'a'.repeat(64) }])
})

void test('normalizeConfig safely repairs legacy disabled and trusted conflicts', () => {
  const config = normalizeConfig({
    providers: [{ id: 'p', name: 'P', type: 'openai', models: [{ id: 'm', name: 'm', enabled: true }], currentModelId: 'm' }],
    activeProviderId: 'p',
    disabledSkills: ['conflicted-skill'],
    trustedSkills: [
      { id: 'conflicted-skill', fingerprint: 'a'.repeat(64) },
      { id: 'enabled-skill', fingerprint: 'b'.repeat(64) }
    ]
  })
  assert.equal(config.disabledSkills, undefined)
  assert.deepEqual(config.trustedSkills, [{ id: 'enabled-skill', fingerprint: 'b'.repeat(64) }])
})

void test('normalizeConfig safely repairs oversized legacy disabled and trusted conflicts', () => {
  const config = normalizeConfig({
    providers: [{ id: 'p', name: 'P', type: 'openai', models: [{ id: 'm', name: 'm', enabled: true }], currentModelId: 'm' }],
    activeProviderId: 'p',
    disabledSkills: [...Array.from({ length: 100 }, (_, index) => `disabled-${index}`), 'conflicted-skill'],
    trustedSkills: [{ id: 'conflicted-skill', fingerprint: 'a'.repeat(64) }]
  })
  assert.deepEqual(config.trustedSkills, [])
})

void test('normalizeConfig preserves more than 100 enabled Skill fingerprints', () => {
  const records = Array.from({ length: 101 }, (_, index) => ({
    id: `skill-${index}`,
    fingerprint: index.toString(16).padStart(64, '0')
  }))
  const config = normalizeConfig({
    providers: [{ id: 'p', name: 'P', type: 'openai', models: [{ id: 'm', name: 'm', enabled: true }], currentModelId: 'm' }],
    activeProviderId: 'p',
    trustedSkills: records
  })
  assert.equal(config.trustedSkills?.length, 101)
  assert.deepEqual(config.trustedSkills?.[100], records[100])
})

void test('normalizeConfig validates and de-duplicates enabled Skill fingerprint records', () => {
  const config = normalizeConfig({
    providers: [{ id: 'p', name: 'P', type: 'openai', models: [{ id: 'm', name: 'm', enabled: true }], currentModelId: 'm' }],
    activeProviderId: 'p',
    trustedSkills: [
      { id: 'safe-skill', fingerprint: 'a'.repeat(64) },
      { id: 'safe-skill', fingerprint: 'b'.repeat(64) },
      { id: '../unsafe', fingerprint: 'c'.repeat(64) },
      { id: 'bad-fingerprint', fingerprint: 'not-a-hash' }
    ]
  })
  assert.deepEqual(config.trustedSkills, [{ id: 'safe-skill', fingerprint: 'a'.repeat(64) }])
})

void test('config save state preserves only canonical Skill fingerprint records', () => {
  const existing = normalizeConfig({
    providers: [{ id: 'p', name: 'P', type: 'openai', models: [{ id: 'm', name: 'm', enabled: true }], currentModelId: 'm' }],
    activeProviderId: 'p',
    trustedSkills: [{ id: 'enabled-skill', fingerprint: 'a'.repeat(64) }]
  })
  const incoming = normalizeConfig({
    providers: [{ id: 'p2', name: 'P2', type: 'openai', models: [{ id: 'm2', name: 'm2', enabled: true }], currentModelId: 'm2' }],
    activeProviderId: 'p2'
  })

  const preserved = preserveSkillConfigState(incoming, existing)
  assert.equal(preserved.disabledSkills, undefined)
  assert.equal(preserved.skillStateVersion, 1)
  assert.deepEqual(preserved.trustedSkills, existing.trustedSkills)
  assert.equal(preserved.activeProviderId, 'p2')
})

void test('normalizeConfig defaults usage reporting and prompt cache to enabled', () => {
  const config = normalizeConfig({
    providers: [{ id: 'p', name: 'P', type: 'openai-compatible', models: [{ id: 'm', name: 'm', enabled: true }], currentModelId: 'm' }],
    activeProviderId: 'p'
  })
  assert.equal(config.providers[0].includeUsage, true)
  assert.equal(config.providers[0].promptCache, true)
})

void test('normalizeConfig preserves disabled usage reporting and prompt cache', () => {
  const config = normalizeConfig({
    providers: [{ id: 'p', name: 'P', type: 'openai-compatible', includeUsage: false, promptCache: false, models: [{ id: 'm', name: 'm', enabled: true }], currentModelId: 'm' }],
    activeProviderId: 'p'
  })
  assert.equal(config.providers[0].includeUsage, false)
  assert.equal(config.providers[0].promptCache, false)
})

void test('legacy config receives default model context limit', () => {
  const config = normalizeConfig({ provider: { provider: 'openai', model: 'legacy-model' } })
  assert.equal(config.providers[0].models[0].maxContextTokens, DEFAULT_MAX_CONTEXT_TOKENS)
})

void test('ToolForge full-trust config keeps only canonical, unique workspace grants', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'joker-toolforge-full-trust-'))
  try {
    const config = normalizeConfig({
      providers: [{ id: 'p', name: 'P', type: 'openai', models: [{ id: 'm', name: 'm', enabled: true }], currentModelId: 'm' }],
      activeProviderId: 'p',
      toolForgeFullTrust: { workspacePaths: [workspace, join(workspace, '.'), join(workspace, 'missing')] }
    })
    assert.deepEqual(config.toolForgeFullTrust, { workspacePaths: [workspace] })
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

void test('ToolForge full-trust mutations are workspace-bound and preserve unrelated grants', () => {
  const first = mkdtempSync(join(tmpdir(), 'joker-toolforge-full-trust-first-'))
  const second = mkdtempSync(join(tmpdir(), 'joker-toolforge-full-trust-second-'))
  try {
    const base = normalizeConfig({
      providers: [{ id: 'p', name: 'P', type: 'openai', models: [{ id: 'm', name: 'm', enabled: true }], currentModelId: 'm' }],
      activeProviderId: 'p'
    })
    const granted = setToolForgeFullTrust(setToolForgeFullTrust(base, first, true), second, true)
    assert.equal(hasToolForgeFullTrust(granted, first), true)
    assert.equal(hasToolForgeFullTrust(granted, second), true)
    const revoked = setToolForgeFullTrust(granted, first, false)
    assert.equal(hasToolForgeFullTrust(revoked, first), false)
    assert.equal(hasToolForgeFullTrust(revoked, second), true)
  } finally {
    rmSync(first, { recursive: true, force: true })
    rmSync(second, { recursive: true, force: true })
  }
})
