import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig } from './config'
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

void test('normalizeConfig defaults Skills to enabled unless disabled', () => {
  const config = normalizeConfig({
    providers: [{ id: 'p', name: 'P', type: 'openai', models: [{ id: 'm', name: 'm', enabled: true }], currentModelId: 'm' }],
    activeProviderId: 'p',
    disabledSkills: ['offline-skill']
  })
  assert.deepEqual(config.disabledSkills, ['offline-skill'])
})

void test('legacy config receives default model context limit', () => {
  const config = normalizeConfig({ provider: { provider: 'openai', model: 'legacy-model' } })
  assert.equal(config.providers[0].models[0].maxContextTokens, DEFAULT_MAX_CONTEXT_TOKENS)
})
