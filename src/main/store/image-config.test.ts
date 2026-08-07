import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeImageConfig, resolveActiveImageProvider } from './image-config'

void test('normalizeImageConfig supplies one safe default provider', () => {
  const config = normalizeImageConfig(undefined)

  assert.deepEqual(config, {
    providers: [{
      id: 'image-default',
      enabled: false,
      name: 'Image provider',
      protocol: 'openai-images',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-image-1',
      modelsPath: '/models',
      defaultSize: '1024x1024',
      defaultAspectRatio: '1:1',
      defaultResolution: '1k',
      responseFormat: 'url'
    }],
    activeProviderId: 'image-default'
  })
})

void test('normalizeImageConfig migrates the legacy single provider format', () => {
  const config = normalizeImageConfig({
    enabled: true,
    name: ' Grok image ',
    protocol: 'grok-images',
    baseUrl: 'https://image.example.test/v1///',
    apiKey: 'secret',
    model: 'grok-imagine-image',
    modelsPath: 'v1/models',
    defaultSize: 'invalid',
    defaultAspectRatio: '16:9',
    defaultResolution: '2K',
    responseFormat: 'b64_json'
  })

  assert.equal(config.providers.length, 1)
  assert.equal(config.activeProviderId, 'image-default')
  assert.deepEqual(config.providers[0], {
    id: 'image-default',
    enabled: true,
    name: 'Grok image',
    protocol: 'grok-images',
    baseUrl: 'https://image.example.test/v1',
    apiKey: 'secret',
    model: 'grok-imagine-image',
    modelsPath: '/v1/models',
    defaultSize: '1024x1024',
    defaultAspectRatio: '16:9',
    defaultResolution: '2k',
    responseFormat: 'b64_json'
  })
})

void test('normalizeImageConfig preserves providers and repairs duplicate IDs', () => {
  const config = normalizeImageConfig({
    providers: [
      { id: 'same', enabled: true, name: 'A', model: 'a' },
      { id: 'same', enabled: true, name: 'B', protocol: 'grok-images', model: 'b' }
    ],
    activeProviderId: 'missing'
  })

  assert.deepEqual(config.providers.map((provider) => provider.id), ['same', 'same-2'])
  assert.equal(config.activeProviderId, 'same')
  assert.equal(config.providers[1].protocol, 'grok-images')
})

void test('normalizeImageProvider preserves Agnes and applies its defaults', () => {
  const config = normalizeImageConfig({
    providers: [{
      id: 'agnes',
      enabled: true,
      name: 'Agnes',
      protocol: 'agnes-images',
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      defaultAspectRatio: '21:9',
      defaultResolution: '3K'
    }],
    activeProviderId: 'agnes'
  })

  const provider = config.providers[0]
  assert.equal(provider.protocol, 'agnes-images')
  assert.equal(provider.model, 'agnes-image-2.1-flash')
  assert.equal(provider.defaultAspectRatio, '21:9')
  assert.equal(provider.defaultResolution, '3k')
})

void test('normalizeImageProvider rejects invalid Agnes ratio and resolution', () => {
  const config = normalizeImageConfig({
    providers: [{
      id: 'agnes-bad',
      protocol: 'agnes-images',
      defaultAspectRatio: '7:5',
      defaultResolution: '9k'
    }],
    activeProviderId: 'agnes-bad'
  })

  assert.equal(config.providers[0].defaultAspectRatio, '1:1')
  assert.equal(config.providers[0].defaultResolution, '1k')
})

void test('normalizeImageProvider keeps Grok resolution limited to 1k 2k 4k', () => {
  const config = normalizeImageConfig({
    providers: [{
      id: 'grok-3k',
      protocol: 'grok-images',
      defaultResolution: '3k'
    }],
    activeProviderId: 'grok-3k'
  })

  assert.equal(config.providers[0].protocol, 'grok-images')
  assert.equal(config.providers[0].defaultResolution, '1k')
})

void test('resolveActiveImageProvider prefers active then enabled fallback', () => {
  const config = normalizeImageConfig({
    providers: [
      { id: 'disabled', enabled: false, name: 'Disabled' },
      { id: 'enabled', enabled: true, name: 'Enabled', model: 'image-b' }
    ],
    activeProviderId: 'disabled'
  })

  assert.equal(resolveActiveImageProvider(config).id, 'enabled')
})

void test('resolveActiveImageProvider rejects configurations with no enabled provider', () => {
  const config = normalizeImageConfig({
    providers: [{ id: 'disabled', enabled: false, name: 'Disabled' }],
    activeProviderId: 'disabled'
  })

  assert.throws(() => resolveActiveImageProvider(config), /No enabled image provider/)
})
