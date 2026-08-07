import { z } from 'zod'

function walk(value: unknown, seen = new Set<object>()): void {
  if (!value || typeof value !== 'object') return
  if (seen.has(value as object)) throw new Error('Generated Tool JSON Schema must be acyclic')
  seen.add(value as object)
  if (Array.isArray(value)) {
    for (const item of value) walk(item, seen)
  } else {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === '$ref' && typeof item === 'string' && !item.startsWith('#/')) {
        throw new Error('Generated Tool JSON Schema remote references are not supported')
      }
      walk(item, seen)
    }
  }
  seen.delete(value as object)
}

export function assertSupportedGeneratedToolJsonSchema(schema: Record<string, unknown>): void {
  walk(schema)
}

export function compileGeneratedToolContractSchema(schema: Record<string, unknown>): z.ZodType {
  assertSupportedGeneratedToolJsonSchema(schema)
  return z.fromJSONSchema(schema)
}

export function compileGeneratedToolInputSchema(schema: Record<string, unknown>): z.ZodObject<z.ZodRawShape> {
  if (schema['type'] !== 'object') throw new Error('Generated Tool input schema must be an object schema')
  const parsed = compileGeneratedToolContractSchema(schema)
  if (!(parsed instanceof z.ZodObject)) throw new Error('Generated Tool input schema did not produce an object validator')
  return parsed
}
