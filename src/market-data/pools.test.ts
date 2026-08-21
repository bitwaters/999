import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePool, selectPrimaryPool } from './pools.js';

const raw = (address: string, reserve: string) => ({
  pool_address: address,
  base_token_address: 'token',
  quote_token_address: 'usd',
  reserve_usd: reserve,
  volume_usd_24h: '100',
  trades_24h: 10,
  pool_created_at: 1_000,
  rest_supported: true,
  g2_supported: true,
});

test('pool parser derives target side and preserves decimal strings', () => {
  const result = parsePool(raw('pool-a', '123.4500'), 'sol', 'token');
  assert.equal(result.status, 'complete');
  if (result.status === 'complete') {
    assert.equal(result.pool.targetSide, 'base');
    assert.equal(result.pool.reserveUsd, '123.45');
    assert.equal(result.pool.identityKey, 'sol:pool-a:token');
  }
  const quote = parsePool(raw('pool-b', '100'), 'bsc', 'usd');
  assert.equal(quote.status, 'complete');
  if (quote.status === 'complete') assert.equal(quote.pool.targetSide, 'quote');
});

test('pool parser rejects type drift and primary selection is deterministic', () => {
  const invalid = parsePool({ ...raw('pool-a', '100'), reserve_usd: 100 }, 'sol', 'token');
  assert.equal(invalid.status, 'invalid');
  const pools = [
    parsePool(raw('pool-z', '100'), 'sol', 'token'),
    parsePool(raw('pool-a', '100'), 'sol', 'token'),
    parsePool({ ...raw('pool-b', '200'), g2_supported: false }, 'sol', 'token'),
  ];
  const complete = pools.flatMap((item) => (item.status === 'complete' ? [item.pool] : []));
  const selected = selectPrimaryPool(complete);
  assert.equal(selected.status, 'resolved');
  if (selected.status === 'resolved') assert.equal(selected.pool.poolAddress, 'pool-a');
  assert.equal(selectPrimaryPool([]).status, 'unresolved');
});

test('BSC pool identity matching is case-insensitive', () => {
  const result = parsePool(
    {
      ...raw('0xabcdef0123456789012345678901234567890123', '100'),
      base_token_address: '0xABCDEF0123456789012345678901234567890123',
      quote_token_address: '0x0000000000000000000000000000000000000001',
    },
    'bsc',
    '0xabcdef0123456789012345678901234567890123',
  );
  assert.equal(result.status, 'complete');
  if (result.status === 'complete') assert.equal(result.pool.targetSide, 'base');
  assert.equal(
    parsePool(
      {
        ...raw('0xabcdef0123456789012345678901234567890123', '100'),
        base_token_address: '0xABCDEF0123456789012345678901234567890123',
        quote_token_address: '0xabcdef0123456789012345678901234567890123',
      },
      'bsc',
      '0xabcdef0123456789012345678901234567890123',
    ).status,
    'invalid',
  );
});
