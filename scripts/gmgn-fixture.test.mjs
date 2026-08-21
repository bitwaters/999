import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeGmgnFixture } from './gmgn-fixture.mjs';

test('sanitizes GMGN fixture auth fields without removing token addresses', () => {
  const sanitized = sanitizeGmgnFixture(
    {
      authorization: 'secret-key',
      api_key: 'secret-key',
      headers: { authorization: 'secret-key' },
      token_address: '0xpublic-token',
      nested: { url: 'https://example.test?k=secret-key' },
    },
    ['secret-key'],
  );

  assert.deepEqual(sanitized, {
    token_address: '0xpublic-token',
    nested: { url: 'https://example.test?k=[REDACTED]' },
  });
});

test('redacts URL-encoded secrets in primitive fixture values', () => {
  const sanitized = sanitizeGmgnFixture('https://example.test?k=secret-key%2B%2F%3D', [
    'secret-key+/=',
  ]);
  assert.equal(sanitized, 'https://example.test?k=[REDACTED]');
});
