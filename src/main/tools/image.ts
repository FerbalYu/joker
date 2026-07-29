import { z } from 'zod'
import type { ToolDefinition } from './registry'
import { loadImageConfig, resolveActiveImageProvider } from '../store/image-config'
import { generateImage } from '../providers/image'
import { saveGeneratedImage } from '../store/generated-images'

const schema = z.object({
  prompt: z.string().min(1).max(8_000).describe('Visual description of the image to generate'),
  size: z.string().regex(/^\d{2,5}x\d{2,5}$/).optional().describe('Image size for OpenAI Images, for example 1024x1024'),
  aspectRatio: z.string().regex(/^\d{1,3}:\d{1,3}$/).optional().describe('Aspect ratio for Grok Images, for example 16:9'),
  resolution: z.enum(['1k', '2k', '4k']).optional().describe('Resolution for Grok Images')
})

export const imageTools: ToolDefinition[] = [
  {
    name: 'GenerateImage',
    description: 'Generate one image from a text prompt using the separately configured image provider. The result is saved locally and returned as a lightweight reference.',
    inputSchema: schema,
    execute: async (input, context) => {
      const parsed = schema.parse(input)
      const config = loadImageConfig()
      const provider = resolveActiveImageProvider(config)
      const payload = await generateImage(provider, parsed, context.abortSignal)
      const image = await saveGeneratedImage(context.sessionId, payload, provider, context.abortSignal)
      return {
        output: `Generated image saved as ${image.filename}`,
        metadata: { generatedImages: [image] }
      }
    }
  }
]
