import { z } from 'zod'

export const GeneratedToolLifecycleCommandSchema = z.object({
  operation: z.enum(['enable', 'disable', 'reenable', 'rollback', 'remove']),
  toolId: z.string().trim().min(1).max(128),
  expectedRevision: z.number().int().nonnegative(),
  operationId: z.string().trim().min(1).max(256),
  versionId: z.string().trim().min(1).max(128).optional()
}).strict()

export type GeneratedToolLifecycleCommand = z.infer<typeof GeneratedToolLifecycleCommandSchema>

export function parseGeneratedToolLifecycleCommand(value: unknown): GeneratedToolLifecycleCommand {
  return GeneratedToolLifecycleCommandSchema.parse(value)
}
