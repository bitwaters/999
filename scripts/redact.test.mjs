import assert from 'node:assert/strict';
import test from 'node:test';
import { redactSecrets } from './redact.mjs';

test('redacts raw and URL-encoded secrets without changing safe text', () => {
  const secret = 'bot-token+/=';
  const value = `url=${encodeURIComponent(secret)} raw=${secret} safe=HTTP-429`;
  const redacted = redactSecrets(value, [secret]);

  assert.equal(redacted, 'url=[REDACTED] raw=[REDACTED] safe=HTTP-429');
  assert.doesNotMatch(redacted, /bot-token/);
});

test('ignores blank secret values', () => {
  assert.equal(redactSecrets('safe text', ['', undefined, null]), 'safe text');
});
