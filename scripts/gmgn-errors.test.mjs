import assert from 'node:assert/strict';
import test from 'node:test';
import { isGmgnRateLimitOrBan } from './gmgn-errors.mjs';

test('identifies GMGN rate-limit and temporary-ban responses', () => {
  assert.equal(isGmgnRateLimitOrBan('HTTP 429'), true);
  assert.equal(isGmgnRateLimitOrBan('RATE_LIMIT_BANNED'), true);
  assert.equal(isGmgnRateLimitOrBan('normal provider error'), false);
});
