import assert from 'node:assert/strict'
import test from 'node:test'

import { z } from 'zod'

import { compileGeneratedToolInputSchema } from './json-schema'

void test('generated operation unions compile to the object schema required by ToolDefinition', () => {
  const schema = compileGeneratedToolInputSchema({
    oneOf: [
      {
        type: 'object',
        properties: {
          operation: { const: 'open' },
          url: { type: 'string' }
        },
        required: ['operation', 'url'],
        additionalProperties: false
      },
      {
        type: 'object',
        properties: {
          operation: { enum: ['snapshot', 'inspect'] },
          page_id: { type: 'string' }
        },
        required: ['operation', 'page_id'],
        additionalProperties: false
      }
    ]
  })

  assert.ok(schema instanceof z.ZodObject)
  assert.equal(schema.safeParse({ operation: 'open', url: 'http://127.0.0.1' }).success, true)
  assert.equal(schema.safeParse({ operation: 'snapshot', page_id: 'page-1' }).success, true)
  assert.equal(schema.safeParse({ operation: 'unsupported' }).success, false)
})

void test('generated scalar input schemas still fail closed', () => {
  assert.throws(
    () => compileGeneratedToolInputSchema({ type: 'string' }),
    /must be an object schema/
  )
})

void test('top-level object unions may omit branch types and resolve legacy definitions', () => {
  const schema = compileGeneratedToolInputSchema({
    type: 'object',
    oneOf: [
      {
        required: ['operation', 'path'],
        properties: {
          operation: { const: 'inspect' },
          path: { $ref: '#/definitions/localPath' }
        },
        additionalProperties: false
      },
      {
        required: ['operation', 'reference_path'],
        properties: {
          operation: { const: 'compare' },
          reference_path: { $ref: '#/definitions/localPath' }
        },
        additionalProperties: false
      }
    ],
    definitions: {
      localPath: { type: 'string', pattern: '^assets/' }
    }
  })

  assert.deepEqual(schema.safeParse({ operation: 'inspect', path: 'assets/a.png' }), {
    success: true,
    data: { operation: 'inspect', path: 'assets/a.png' }
  })
  assert.equal(schema.safeParse({ operation: 'inspect', path: 'tmp/a.png' }).success, false)
  assert.equal(schema.safeParse({ operation: 'compare', reference_path: 'assets/b.png' }).success, true)
})

void test('conditional Generated Tool schemas stay strict without exposing unsupported provider keywords', () => {
  const schema = compileGeneratedToolInputSchema({
    type: 'object',
    additionalProperties: false,
    required: ['operation', 'path'],
    properties: {
      operation: { type: 'string', enum: ['inspect', 'extract', 'search'] },
      path: { type: 'string', minLength: 1 },
      query: { type: 'string', minLength: 1 },
      pages: { type: 'array', items: { type: 'integer', minimum: 1 } }
    },
    allOf: [
      { if: { properties: { operation: { const: 'search' } } }, then: { required: ['query'] } },
      { if: { properties: { operation: { const: 'inspect' } } }, then: { not: { required: ['pages'] } } }
    ]
  })

  assert.equal(schema.safeParse({ operation: 'search', path: 'input/report.pdf' }).success, false)
  assert.equal(schema.safeParse({ operation: 'search', path: 'input/report.pdf', query: 'revenue' }).success, true)
  assert.equal(schema.safeParse({ operation: 'inspect', path: 'input/report.pdf', pages: [1] }).success, false)
  assert.equal(schema.safeParse({ operation: 'inspect', path: 'input/report.pdf' }).success, true)

  const providerSchema = JSON.stringify(z.toJSONSchema(schema))
  assert.equal(/"(?:if|then|else)":/.test(providerSchema), false)
})
