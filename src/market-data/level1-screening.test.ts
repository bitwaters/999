import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CanonicalPool } from './pools.js';
import {
  parseLevel1ScreeningSnapshot,
  promoteLevel1ScreeningSnapshot,
  type RawLevel1Screening,
} from './level1-screening.js';

const solPool: CanonicalPool = {
  chain: 'sol',
  poolAddress: 'Pool111',
  tokenAddress: 'Token111',
  baseTokenAddress: 'Token111',
  quoteTokenAddress: 'Quote111',
  targetSide: 'base',
  reserveUsd: '10000',
  volumeUsd24h: '5000',
  trades24h: 10,
  poolCreatedAt: 0,
  restSupported: true,
  g2Supported: true,
  identityKey: 'sol:Pool111:Token111',
};

function raw(overrides: RawLevel1Screening = {}): RawLevel1Screening {
  const window = (factor: number) => ({
    buys: 3 * factor,
    sells: factor,
    buyers: 2 * factor,
    sellers: factor,
    volume_usd: String(1000 * factor),
    buy_volume_usd: String(700 * factor),
    sell_volume_usd: String(300 * factor),
    net_buy_usd: String(400 * factor),
  });
  return {
    pool_address: solPool.poolAddress,
    token_address: solPool.tokenAddress,
    base_token_address: solPool.baseTokenAddress,
    quote_token_address: solPool.quoteTokenAddress,
    target_side: 'base',
    rest_supported: true,
    g2_supported: true,
    pool_created_at: 0,
    reserve_usd: '10000',
    price_usd: '1.25',
    base_token_balance: '8000',
    quote_token_balance: '10000',
    windows: { m5: window(1), m15: window(2), m30: window(3) },
    ...overrides,
  };
}

test('parses a standard pool without requiring launchpad or migration fields', () => {
  const parsed = parseLevel1ScreeningSnapshot(raw(), solPool, 600_000);
  assert.equal(parsed.status, 'complete');
  if (parsed.status === 'complete') {
    assert.equal(parsed.snapshot.poolStatus, 'stable');
    assert.equal(parsed.snapshot.windows.m5?.buyers, 2);
    assert.equal(parsed.snapshot.migration, undefined);
  }
});

test('normal reserve and composition changes remain stable', () => {
  const parsed = parseLevel1ScreeningSnapshot(
    raw({ reserve_usd: '25000', base_token_balance: '7000', quote_token_balance: '13000' }),
    solPool,
    600_000,
  );
  assert.equal(parsed.status, 'complete');
  if (parsed.status === 'complete') {
    assert.equal(parsed.snapshot.reserveUsd, '25000');
    assert.equal(parsed.snapshot.baseTokenBalance, '7000');
  }
});

test('missing promised composition is incomplete while identity and migration conflicts are unstable', () => {
  const missing = raw();
  delete missing.base_token_balance;
  const incomplete = parseLevel1ScreeningSnapshot(missing, solPool, 600_000);
  assert.equal(incomplete.status, 'incomplete');
  if (incomplete.status === 'incomplete')
    assert.ok(incomplete.reasons.includes('missing:base_token_balance'));

  const identity = parseLevel1ScreeningSnapshot(
    raw({ pool_address: 'OtherPool' }),
    solPool,
    600_000,
  );
  assert.equal(identity.status, 'unstable');

  const migrating = parseLevel1ScreeningSnapshot(
    raw({ migration: { state: 'migrating' } }),
    solPool,
    600_000,
  );
  assert.equal(migrating.status, 'unstable');
  if (migrating.status === 'unstable')
    assert.ok(migrating.reasons.includes('migration:in_progress'));

  const completedWithoutTarget = parseLevel1ScreeningSnapshot(
    raw({ migration: { state: 'completed' } }),
    solPool,
    600_000,
  );
  assert.equal(completedWithoutTarget.status, 'incomplete');
});

test('BSC screening identity matching is case-insensitive', () => {
  const pool: CanonicalPool = {
    ...solPool,
    chain: 'bsc',
    poolAddress: '0x1234567890abcdef1234567890abcdef12345678',
    tokenAddress: '0xabcdef0123456789012345678901234567890123',
    baseTokenAddress: '0xabcdef0123456789012345678901234567890123',
    quoteTokenAddress: '0x0000000000000000000000000000000000000001',
    identityKey:
      'bsc:0x1234567890abcdef1234567890abcdef12345678:0xabcdef0123456789012345678901234567890123',
  };
  const upper = (address: string) => `0x${address.slice(2).toUpperCase()}`;
  const parsed = parseLevel1ScreeningSnapshot(
    raw({
      pool_address: upper(pool.poolAddress),
      token_address: upper(pool.tokenAddress),
      base_token_address: upper(pool.baseTokenAddress),
      quote_token_address: upper(pool.quoteTokenAddress),
    }),
    pool,
    600_000,
  );
  assert.equal(parsed.status, 'complete');
});

test('only identity-matched REST or G2 event time promotes screening evidence', () => {
  const parsed = parseLevel1ScreeningSnapshot(raw(), solPool, 600_000);
  assert.equal(parsed.status, 'complete');
  if (parsed.status !== 'complete') return;
  const promoted = promoteLevel1ScreeningSnapshot(parsed.snapshot, {
    source: 'rest',
    chain: 'sol',
    poolAddress: solPool.poolAddress,
    tokenAddress: solPool.tokenAddress,
    eventAt: 599_000,
    observedAt: 601_000,
  });
  assert.equal(promoted.status, 'complete');
  if (promoted.status === 'complete') {
    assert.equal(promoted.snapshot.observedAt, 601_000);
    assert.equal(promoted.snapshot.lastTradeAt, 599_000);
    assert.notEqual(promoted.snapshot.lastTradeAt, parsed.snapshot.observedAt);
  }

  const mismatch = promoteLevel1ScreeningSnapshot(parsed.snapshot, {
    source: 'g2',
    chain: 'sol',
    poolAddress: 'OtherPool',
    tokenAddress: solPool.tokenAddress,
    eventAt: 599_000,
    observedAt: 601_000,
  });
  assert.equal(mismatch.status, 'incomplete');
});
