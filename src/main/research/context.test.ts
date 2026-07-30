import test from 'node:test'
import assert from 'node:assert/strict'
import { createResearchContext, hashResearchContent, normalizeResearchText, normalizeResearchUrl } from './context'

void test('research context normalizes URLs, assigns stable source ids, and hashes content', () => {
  const context = createResearchContext()
  const first = context.registerSource({
    url: 'HTTPS://Example.COM:443/path/?b=2&a=1#fragment',
    title: '  Example   Title ',
    text: 'Alpha\n\nBeta',
    retrievedAt: '2026-01-01T00:00:00Z'
  })
  const duplicate = context.registerSource({
    url: 'https://example.com/path?a=1&b=2',
    text: 'ignored duplicate body'
  })
  const second = context.registerSource({ url: 'https://example.org/article', text: 'Gamma' })

  assert.equal(normalizeResearchUrl('HTTPS://Example.COM:443/path/?b=2&a=1#fragment'), 'https://example.com/path?a=1&b=2')
  assert.equal(first.sourceId, 'S1')
  assert.equal(duplicate.sourceId, 'S1')
  assert.equal(second.sourceId, 'S2')
  assert.equal(first.title, 'Example Title')
  assert.equal(first.contentHash, hashResearchContent('Alpha\n\nBeta'))
  assert.match(first.contentHash, /^sha256:[a-f0-9]{64}$/)
})

void test('research context validates normalized citation substrings and report sources', () => {
  const context = createResearchContext()
  context.registerSource({ url: 'https://example.com/article', text: 'The\n verified   fact is here.' })
  assert.equal(normalizeResearchText('The\n verified   fact'), 'The verified fact')
  assert.equal(context.validateCitation({ sourceId: 'S1', quote: 'verified fact is here' }), null)
  assert.match(context.validateCitation({ sourceId: 'S1', quote: 'invented fact' }) ?? '', /not a normalized substring/)
  assert.match(context.validateCitation({ sourceId: 'S2', quote: 'fact' }) ?? '', /Unknown sourceId/)

  const valid = context.validateReport({
    title: 'Report',
    summary: 'Summary',
    sections: [{ heading: 'Finding', paragraphs: [{ text: 'Fact.', citations: [{ sourceId: 'S1', quote: 'verified fact' }] }] }]
  })
  assert.equal(valid.success, true)
  assert.deepEqual(valid.sources.map((source) => source.sourceId), ['S1'])
})

void test('research context enforces per-run search and read budgets', () => {
  const context = createResearchContext()
  for (let index = 0; index < 6; index += 1) context.consumeSearch()
  assert.throws(() => context.consumeSearch(), /WebSearch budget exhausted/)
  for (let index = 0; index < 12; index += 1) context.consumeRead()
  assert.throws(() => context.consumeRead(), /WebRead budget exhausted/)
  assert.deepEqual(context.budgets, { searchesUsed: 6, searchesLimit: 6, readsUsed: 12, readsLimit: 12 })
})
