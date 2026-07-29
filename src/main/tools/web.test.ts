import test from 'node:test'
import assert from 'node:assert/strict'
import { extractHtmlText, normalizeOptions, validateWebUrl } from './web'
import { isPrivateAddress } from './url-policy'

void test('validateWebUrl accepts only public web schemes', () => {
  assert.equal(validateWebUrl('https://example.com/article').protocol, 'https:')
  assert.throws(() => validateWebUrl('file:///tmp/article'))
  assert.throws(() => validateWebUrl('javascript:alert(1)'))
  assert.throws(() => validateWebUrl('https://user:pass@example.com'))
})

void test('public URL policy rejects private, metadata, ULA, link-local, and mapped addresses', () => {
  for (const address of ['127.0.0.1', '169.254.169.254', '10.0.0.1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', 'metadata.google.internal']) {
    assert.equal(isPrivateAddress(address), true, address)
  }
})
void test('normalizeOptions clamps request limits', () => {
  assert.deepEqual(normalizeOptions({ timeoutMs: 1, maxChars: 999999 }), {
    timeoutMs: 3_000,
    maxChars: 50_000
  })
})

void test('extractHtmlText removes executable and presentation content', () => {
  const result = extractHtmlText('<html><head><title>News &amp; More</title><script>alert(1)</script></head><body><h1>Hello</h1><p>World</p><style>.x{}</style></body></html>')
  assert.equal(result.title, 'News & More')
  assert.match(result.text, /Hello/)
  assert.match(result.text, /World/)
  assert.doesNotMatch(result.text, /alert|\.x/)
})
