import test from 'node:test'
import assert from 'node:assert/strict'
import type { ImageProviderConfig } from '@shared/types'
import {
  maskImageConfig,
  restoreImageConfigApiKeys,
  restoreImageProviderApiKey
} from './image-config-helpers'

const existing: ImageProviderConfig = {
  providers: [
    {
      id: 'image-a', enabled: true, name: 'A', protocol: 'openai-images',
      baseUrl: 'https://a.example.test/v1', apiKey: 'aaaa-secret-1111', model: 'a', modelsPath: '/models',
      defaultSize: '1024x1024', defaultAspectRatio: '1:1', defaultResolution: '1k', responseFormat: 'url'
    },
    {
      id: 'image-b', enabled: true, name: 'B', protocol: 'grok-images',
      baseUrl: 'https://b.example.test/v1', apiKey: 'bbbb-secret-2222', model: 'b', modelsPath: '/models',
      defaultSize: '1024x1024', defaultAspectRatio: '16:9', defaultResolution: '2k', responseFormat: 'url'
    }
  ],
  activeProviderId: 'image-b'
}

void test('maskImageConfig masks every provider without changing identity', () => {
  const masked = maskImageConfig(existing)
  assert.equal(masked.activeProviderId, 'image-b')
  assert.deepEqual(masked.providers.map((provider) => [provider.id, provider.apiKey]), [
    ['image-a', 'aaaa••••1111'],
    ['image-b', 'bbbb••••2222']
  ])
  assert.equal(existing.providers[0].apiKey, 'aaaa-secret-1111')
})

void test('restoreImageConfigApiKeys restores masked keys by provider ID after reordering', () => {
  const incoming = maskImageConfig({
    providers: [existing.providers[1], existing.providers[0]],
    activeProviderId: 'image-b'
  })
  const restored = restoreImageConfigApiKeys(incoming, existing)

  assert.deepEqual(restored.providers.map((provider) => [provider.id, provider.apiKey]), [
    ['image-b', 'bbbb-secret-2222'],
    ['image-a', 'aaaa-secret-1111']
  ])
})

void test('unknown masked providers never inherit another provider key', () => {
  const unknown = { ...existing.providers[0], id: 'image-new', apiKey: '••••' }
  assert.equal(restoreImageProviderApiKey(unknown, existing).apiKey, '')
})

void test('plain-text replacement keys override stored keys', () => {
  const changed = {
    ...maskImageConfig(existing),
    providers: existing.providers.map((provider) =>
      provider.id === 'image-a' ? { ...provider, apiKey: 'new-key' } : { ...provider, apiKey: 'bbbb••••2222' }
    )
  }
  const restored = restoreImageConfigApiKeys(changed, existing)
  assert.equal(restored.providers[0].apiKey, 'new-key')
  assert.equal(restored.providers[1].apiKey, 'bbbb-secret-2222')
})
