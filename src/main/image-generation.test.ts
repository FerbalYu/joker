import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import type { GeneratedImageRef, StreamEvent } from '@shared/types'
import { matchImageGenerationRequest, runDirectImageGeneration } from './image-generation'
import type { ToolContext } from './tools/registry'

void test('matchImageGenerationRequest strips only explicit image command prefixes', () => {
  assert.deepEqual(matchImageGenerationRequest('生成图片：红发女性，霓虹灯'), { prompt: '红发女性，霓虹灯' })
  assert.deepEqual(matchImageGenerationRequest('请帮我画 一只戴帽子的猫'), { prompt: '一只戴帽子的猫' })
  assert.deepEqual(matchImageGenerationRequest('/image Painted clown female warrior'), { prompt: 'Painted clown female warrior' })
  assert.deepEqual(matchImageGenerationRequest('generate an image: nude figure study'), { prompt: 'nude figure study' })
})

void test('matchImageGenerationRequest avoids image-feature questions and incomplete commands', () => {
  assert.equal(matchImageGenerationRequest('修复生成图片功能'), null)
  assert.equal(matchImageGenerationRequest('为什么不能生成图片？'), null)
  assert.equal(matchImageGenerationRequest('生成图片'), null)
  assert.equal(matchImageGenerationRequest('生成图片接口应该怎么配置'), null)
})

void test('runDirectImageGeneration preserves the prompt and uses the normal approval boundary', async () => {
  const events: StreamEvent[] = []
  const approvals: Array<{ toolName: string; input: Record<string, unknown> }> = []
  const context: ToolContext = {
    workspacePath: null,
    sessionId: 'direct-image-session',
    runId: 'direct-image-run',
    approvalGate: async (toolName, input) => {
      approvals.push({ toolName, input })
      return { outcome: 'deny', risk: 'external', reason: 'test denial' }
    }
  }

  const result = await runDirectImageGeneration({
    sessionId: context.sessionId,
    runId: context.runId ?? '',
    prompt: '裸体人物写生，不要翻译',
    context,
    onEvent: (event) => { events.push(event) }
  })

  assert.deepEqual(approvals, [{ toolName: 'GenerateImage', input: { prompt: '裸体人物写生，不要翻译' } }])
  assert.deepEqual(events.map((event) => event.type), ['message-start', 'tool-call', 'tool-result'])
  const call = events.find((event) => event.type === 'tool-call')
  assert.deepEqual(call && call.type === 'tool-call' ? call.input : undefined, { prompt: '裸体人物写生，不要翻译' })
  const toolResult = events.find((event) => event.type === 'tool-result')
  assert.equal(toolResult && toolResult.type === 'tool-result' ? toolResult.output : undefined, 'Tool call was denied.')
  assert.equal(result.status, 'completed')
  assert.equal(result.status === 'completed' ? result.message.toolCalls?.[0]?.status : undefined, 'done')
  assert.equal(result.status === 'completed' ? result.message.toolCalls?.[0]?.output : undefined, 'Tool call was denied.')
})

void test('runDirectImageGeneration returns a persistable assistant message with generated image metadata', async () => {
  const events: StreamEvent[] = []
  const generatedImage: GeneratedImageRef = {
    id: 'generated-image-direct',
    sessionId: 'direct-image-success-session',
    filename: 'generated-image-direct.jpg',
    mediaType: 'image/jpeg',
    sizeBytes: 2048,
    createdAt: 456
  }
  const context: ToolContext = {
    workspacePath: null,
    sessionId: generatedImage.sessionId,
    runId: 'direct-image-success-run',
    approvalGate: async () => ({ outcome: 'allow', risk: 'external', reason: 'test approval' })
  }

  const result = await runDirectImageGeneration({
    sessionId: context.sessionId,
    runId: context.runId ?? '',
    prompt: 'painted clown warrior',
    context,
    tool: {
      name: 'GenerateImage',
      description: 'test image tool',
      inputSchema: z.object({ prompt: z.string() }),
      execute: async () => ({
        output: `Generated image saved as ${generatedImage.filename}`,
        metadata: { generatedImages: [generatedImage] }
      })
    },
    onEvent: (event) => { events.push(event) }
  })

  assert.equal(result.status, 'completed')
  assert.deepEqual(events.map((event) => event.type), ['message-start', 'tool-call', 'tool-result'])
  assert.deepEqual(result.status === 'completed' ? result.message.toolCalls?.[0]?.metadata?.generatedImages : undefined, [generatedImage])
  assert.deepEqual(result.status === 'completed' && result.message.segments?.[0]?.type === 'tools' ? result.message.segments[0].tools[0]?.metadata?.generatedImages : undefined, [generatedImage])
})

void test('runDirectImageGeneration returns a terminal error tool message without owning done events', async () => {
  const events: StreamEvent[] = []
  const context: ToolContext = {
    workspacePath: null,
    sessionId: 'direct-image-error-session',
    runId: 'direct-image-error-run',
    approvalGate: async () => ({ outcome: 'allow', risk: 'external', reason: 'test approval' })
  }

  const result = await runDirectImageGeneration({
    sessionId: context.sessionId,
    runId: context.runId ?? '',
    prompt: 'broken image',
    context,
    tool: {
      name: 'GenerateImage',
      description: 'failing image tool',
      inputSchema: z.object({ prompt: z.string() }),
      execute: async () => { throw new Error('provider exploded') }
    },
    onEvent: (event) => { events.push(event) }
  })

  assert.equal(result.status, 'error')
  assert.deepEqual(events.map((event) => event.type), ['message-start', 'tool-call', 'tool-error'])
  assert.equal(result.status === 'error' ? result.message.toolCalls?.[0]?.status : undefined, 'error')
  assert.match(result.status === 'error' ? result.message.toolCalls?.[0]?.output ?? '' : '', /provider exploded/)
})
