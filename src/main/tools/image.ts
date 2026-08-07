import { z } from 'zod'
import type { ToolDefinition } from './registry'
import { loadImageConfig, resolveActiveImageProvider } from '../store/image-config'
import { generateImage } from '../providers/image'
import { saveGeneratedImage } from '../store/generated-images'

const schema = z.object({
  prompt: z.string().min(1).max(8_000).describe('Exact user-provided image description in its original language and wording'),
  size: z.string().regex(/^\d{2,5}x\d{2,5}$/).optional().describe('Image size for OpenAI Images, for example 1024x1024'),
  aspectRatio: z.string().regex(/^\d{1,3}:\d{1,3}$/).optional().describe('Aspect ratio: Grok Images uses values like 16:9; Agnes Images accepts only 1:1, 3:4, 4:3, 16:9, 9:16, 2:3, 3:2, 21:9'),
  resolution: z.enum(['1k', '2k', '3k', '4k']).optional().describe('Resolution tier for Grok Images (1k, 2k, 4k) and Agnes Images (1k, 2k, 3k, 4k)')
})

export const imageTools: ToolDefinition[] = [
  {
    name: 'GenerateImage',
    description: 'Generate one image using the exact prompt supplied by the user. Preserve the original language and wording; do not translate, rewrite, expand, improve, sanitize, or add details. The separately configured image provider decides whether the prompt is supported. The result is saved locally and returned as a lightweight reference.',
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
