import test from 'node:test'
import assert from 'node:assert/strict'
import type { ImageProviderConfig, ImageProviderEntry } from '@shared/types'
import { imageTools } from './image'

void test('GenerateImage is a dedicated built-in tool with bounded input', () => {
  const tool = imageTools.find((item) => item.name === 'GenerateImage')
  assert.ok(tool)
  assert.doesNotThrow(() => tool.inputSchema.parse({ prompt: 'Draw a cat', size: '1024x1024' }))
  assert.throws(() => tool.inputSchema.parse({ prompt: '', size: '1024x1024' }))
  assert.throws(() => tool.inputSchema.parse({ prompt: 'Draw a cat', resolution: '8k' }))
})

void test('image provider collections remain separate from chat provider types', () => {
  const provider: ImageProviderEntry = {
    id: 'image-a',
    enabled: true,
    name: 'Images',
    protocol: 'grok-images',
    baseUrl: 'https://image.example.test/v1',
    apiKey: 'secret',
    model: 'grok-imagine-image',
    modelsPath: '/models',
    defaultSize: '1024x1024',
    defaultAspectRatio: '16:9',
    defaultResolution: '2k',
    responseFormat: 'url'
  }
  const config: ImageProviderConfig = { providers: [provider], activeProviderId: provider.id }

  assert.equal(config.providers[0].protocol, 'grok-images')
  assert.equal('type' in config.providers[0], false)
  assert.equal('apiFormat' in config.providers[0], false)
  assert.equal('models' in config.providers[0], false)
})
