import test from 'node:test'
import assert from 'node:assert/strict'
import type { ProviderConfig } from '../../shared/types'
import { providerOptions } from './loop'

function config(overrides: Partial<ProviderConfig>): ProviderConfig {
  return {
    provider: 'openai',
    apiFormat: 'chat-completions',
    model: 'gpt-4o',
    promptCache: true,
    ...overrides
  }
}

test('providerOptions returns undefined when promptCache is disabled', () => {
  assert.equal(providerOptions(config({ promptCache: false })), undefined)
})

test('providerOptions enables Anthropic cacheControl for anthropic-messages', () => {
  assert.deepEqual(
    providerOptions(config({ provider: 'anthropic', apiFormat: 'anthropic-messages', model: 'claude' })),
    { anthropic: { cacheControl: { type: 'ephemeral' } } }
  )
})

test('providerOptions enables OpenAI prompt caching for native OpenAI chat-completions', () => {
  assert.deepEqual(
    providerOptions(config({ provider: 'openai', apiFormat: 'chat-completions', model: 'gpt-5.6' })),
    {
      openai: {
        promptCacheKey: 'joker:openai:gpt-5.6',
        promptCacheOptions: { mode: 'implicit', ttl: '30m' }
      }
    }
  )
})

test('providerOptions does not send chat-completions cache options for the responses format', () => {
  assert.equal(providerOptions(config({ provider: 'openai', apiFormat: 'responses', model: 'gpt-5.6' })), undefined)
})

test('providerOptions is a no-op for openai-compatible chat-completions providers', () => {
  assert.equal(
    providerOptions(config({ provider: 'openai-compatible', apiFormat: 'chat-completions', model: 'grok-4.6' })),
    undefined
  )
})

test('providerOptions is a no-op for ollama providers', () => {
  assert.equal(providerOptions(config({ provider: 'ollama', apiFormat: 'chat-completions', model: 'llama3' })), undefined)
})
