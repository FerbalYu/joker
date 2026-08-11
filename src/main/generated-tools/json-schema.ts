import { z } from 'zod'
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv'

const jsonSchemaValidator = new Ajv({
  allErrors: true,
  allowUnionTypes: true,
  strict: false,
  validateFormats: false
})

const ZOD_UNSUPPORTED_SCHEMA_KEYS = new Set([
  'if',
  'then',
  'else',
  'not',
  'dependentSchemas',
  'dependentRequired',
  'unevaluatedItems',
  'unevaluatedProperties'
])

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Zod exposes object schemas to the AI SDK, but z.fromJSONSchema cannot ingest
 * several valid JSON Schema keywords. Keep those constraints in the host AJV
 * validator while presenting the model with the supported structural subset.
 */
function providerCompatibleSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(providerCompatibleSchema)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !ZOD_UNSUPPORTED_SCHEMA_KEYS.has(key))
    .map(([key, item]) => [key, providerCompatibleSchema(item)]))
}

function compileManifestValidator(schema: Record<string, unknown>): ValidateFunction {
  return jsonSchemaValidator.compile(schema)
}

function validationMessage(error: ErrorObject): string {
  const location = error.instancePath || '/'
  return `Generated Tool input does not match its manifest at ${location}: ${error.message ?? error.keyword}`
}

function enforceManifestSchema<T extends z.ZodType>(schema: T, validate: ValidateFunction): T {
  return schema.superRefine((value, context) => {
    if (validate(value)) return
    for (const error of validate.errors ?? []) {
      context.addIssue({ code: 'custom', message: validationMessage(error) })
    }
  })
}

function schemaFingerprint(value: Record<string, unknown>): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize)
    if (!isRecord(item)) return item
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, normalize(item[key])]))
  }
  return JSON.stringify(normalize(value))
}

function mergePropertySchemas(schemas: Record<string, unknown>[]): Record<string, unknown> {
  const unique = schemas.filter((schema, index) => schemas.findIndex((candidate) => schemaFingerprint(candidate) === schemaFingerprint(schema)) === index)
  if (unique.length === 1) return unique[0]

  const enumValues = unique.flatMap((schema) => {
    if (Array.isArray(schema.enum)) return schema.enum
    return Object.hasOwn(schema, 'const') ? [schema.const] : []
  })
  if (enumValues.length === unique.length && enumValues.every((value) => ['string', 'number', 'boolean'].includes(typeof value))) {
    return { type: typeof enumValues[0], enum: [...new Set(enumValues)] }
  }
  return { oneOf: unique }
}

function normalizeLegacyDefinitions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeLegacyDefinitions)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    key === '$ref' && typeof item === 'string' && item.startsWith('#/definitions/')
      ? `#/$defs/${item.slice('#/definitions/'.length)}`
      : normalizeLegacyDefinitions(item)
  ]))
}

function resolveLocalReferences(value: unknown, root: Record<string, unknown>, seen = new Set<string>()): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveLocalReferences(item, root, seen))
  if (!isRecord(value)) return value
  if (typeof value['$ref'] === 'string' && value['$ref'].startsWith('#/')) {
    const reference = value['$ref']
    if (seen.has(reference)) throw new Error(`Generated Tool JSON Schema reference cycle: ${reference}`)
    const target = reference.slice(2).split('/').reduce<unknown>((current, key) => isRecord(current) ? current[key] : undefined, root)
    if (target === undefined) throw new Error(`Generated Tool JSON Schema reference not found: ${reference}`)
    const nextSeen = new Set(seen)
    nextSeen.add(reference)
    return resolveLocalReferences(target, root, nextSeen)
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveLocalReferences(item, root, seen)]))
}

function compileObjectShapeFallback(schema: Record<string, unknown>): z.ZodObject<z.ZodRawShape> {
  const properties = isRecord(schema['properties']) ? schema['properties'] : {}
  const required = new Set(Array.isArray(schema['required']) ? schema['required'].filter((item): item is string => typeof item === 'string') : [])
  const shape = Object.fromEntries(Object.entries(properties).map(([name, property]) => {
    if (!isRecord(property)) throw new Error(`Generated Tool input property is not a schema: ${name}`)
    const compiled = z.fromJSONSchema(resolveLocalReferences(property, schema) as Record<string, unknown>)
    return [name, required.has(name) ? compiled : compiled.optional()]
  })) as z.ZodRawShape
  const object = z.object(shape)
  return schema['additionalProperties'] === true ? object.passthrough() : object
}

/**
 * AI SDK tool inputs must be object-shaped. Generated tools may still describe
 * operation-discriminated inputs as a top-level oneOf/anyOf of object schemas;
 * flatten that union into one object while retaining all branch properties.
 * Branch-specific required fields remain optional at the host boundary because
 * the generated runtime owns operation-level validation.
 */
function normalizeObjectInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const source = normalizeLegacyDefinitions(schema) as Record<string, unknown>
  if (source['type'] === 'object' && !Array.isArray(source['oneOf']) && !Array.isArray(source['anyOf'])) {
    const { definitions, ...rest } = source
    if (!isRecord(definitions)) return source
    const existingDefinitions = isRecord(rest['$defs']) ? rest['$defs'] : {}
    return { ...rest, $defs: { ...definitions, ...existingDefinitions } }
  }

  const variants = Array.isArray(source['oneOf'])
    ? source['oneOf']
    : Array.isArray(source['anyOf'])
      ? source['anyOf']
      : undefined
  if (!variants || variants.length === 0 || !variants.every(isRecord)) return schema

  const objectVariants = variants.filter((variant) => variant['type'] === 'object'
    || (variant['type'] === undefined && (isRecord(variant['properties']) || Array.isArray(variant['required']))))
  if (objectVariants.length !== variants.length) return schema

  const propertySchemas = new Map<string, Record<string, unknown>[]>()
  for (const variant of objectVariants) {
    const properties = variant['properties']
    if (!isRecord(properties)) continue
    for (const [name, property] of Object.entries(properties)) {
      if (!isRecord(property)) continue
      const existing = propertySchemas.get(name) ?? []
      existing.push(property)
      propertySchemas.set(name, existing)
    }
  }

  const properties = Object.fromEntries([...propertySchemas].map(([name, schemas]) => [name, mergePropertySchemas(schemas)]))
  const requiredSets = objectVariants.map((variant) => new Set(
    Array.isArray(variant['required'])
      ? variant['required'].filter((item): item is string => typeof item === 'string')
      : []
  ))
  const required = requiredSets.length > 0
    ? [...requiredSets[0]].filter((name) => requiredSets.every((set) => set.has(name)))
    : []

  const { oneOf: _oneOf, anyOf: _anyOf, type: _type, properties: _properties, required: _required, definitions: legacyDefinitions, ...rest } = source
  const normalizedRest = normalizeLegacyDefinitions(rest) as Record<string, unknown>
  if (isRecord(legacyDefinitions)) {
    const existingDefinitions = isRecord(normalizedRest['$defs']) ? normalizedRest['$defs'] : {}
    normalizedRest['$defs'] = {
      ...normalizeLegacyDefinitions(legacyDefinitions) as Record<string, unknown>,
      ...existingDefinitions
    }
  }
  return {
    ...normalizedRest,
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: schema['additionalProperties'] ?? false
  }
}

export function assertSupportedGeneratedToolJsonSchema(schema: Record<string, unknown>): void {
  walk(schema)
}

export function compileGeneratedToolContractSchema(schema: Record<string, unknown>): z.ZodType {
  assertSupportedGeneratedToolJsonSchema(schema)
  const validate = compileManifestValidator(schema)
  return enforceManifestSchema(
    z.fromJSONSchema(providerCompatibleSchema(normalizeLegacyDefinitions(schema)) as Record<string, unknown>),
    validate
  )
}

export function compileGeneratedToolInputSchema(schema: Record<string, unknown>): z.ZodObject<z.ZodRawShape> {
  const normalized = normalizeObjectInputSchema(schema)
  if (normalized['type'] !== 'object') throw new Error('Generated Tool input schema must be an object schema')
  assertSupportedGeneratedToolJsonSchema(schema)
  const validate = compileManifestValidator(schema)
  const providerSchema = providerCompatibleSchema(normalized) as Record<string, unknown>
  const parsed = z.fromJSONSchema(providerSchema)
  const object = parsed instanceof z.ZodObject ? parsed : compileObjectShapeFallback(providerSchema)
  return enforceManifestSchema(object, validate)
}
