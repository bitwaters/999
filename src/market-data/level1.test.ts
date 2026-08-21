import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canEnterArmed,
  createLevel1Batches,
  isLevel1Fresh,
  Level1Batcher,
  parseLevel1Snapshot,
  shouldContinueLevel1,
  transitionLevel1State,
} from './level1.js';
import type { CanonicalPool } from './pools.js';

const pool: CanonicalPool = {
  chain: 'sol',
  poolAddress: 'pool',
  tokenAddress: 'token',
  baseTokenAddress: 'token',
  quoteTokenAddress: 'usd',
  targetSide: 'base',
  reserveUsd: '1000',
  volumeUsd24h: '100',
  trades24h: 10,
  poolCreatedAt: 0,
  restSupported: true,
  g2Supported: true,
  identityKey: 'sol:pool:token',
};

const raw = (poolAddress = 'pool') => ({
  pool_address: poolAddress,
  token_address: 'token',
  pool_status: 'stable',
  reserve_usd: '1000',
  price_usd: '1.25',
  buys: 10,
  sells: 4,
  buyers: 8,
  sellers: 3,
  volume_usd: '500',
  net_buy_usd: '250.00',
  pool_age_seconds: 120,
  last_trade_at: 9_000,
});

test('Level 1 parser keeps buyers distinct from trade counts and enforces freshness', () => {
  const parsed = parseLevel1Snapshot(raw(), pool, 10_000);
  assert.equal(parsed.status, 'complete');
  if (parsed.status === 'complete') {
    assert.equal(parsed.snapshot.buyers, 8);
    assert.equal(parsed.snapshot.buys, 10);
    assert.equal(isLevel1Fresh(parsed.snapshot, 54_999, 45), true);
    assert.equal(isLevel1Fresh(parsed.snapshot, 55_001, 45), false);
    assert.deepEqual(canEnterArmed(parsed.snapshot, 54_999, 45), { status: 'pass' });
  }
  assert.equal(parseLevel1Snapshot({ ...raw(), buyers: '8' }, pool, 10_000).status, 'invalid');
});

test('Level 1 batches deduplicate and cap each chain at 50 pools', () => {
  const pools = Array.from({ length: 51 }, (_, index) => ({
    ...pool,
    poolAddress: `pool-${index}`,
    identityKey: `sol:pool-${index}:token`,
  }));
  const batches = createLevel1Batches(
    [...pools, pools[0]!, { ...pool, restSupported: false, poolAddress: 'unresolved' }],
    50,
  );
  assert.deepEqual(
    batches.map((batch) => batch.pools.length),
    [50, 1],
  );
  const batcher = new Level1Batcher({
    maxPoolsPerBatch: 50,
    mergeDelayMs: 300,
    refreshIntervalSeconds: 45,
  });
  assert.equal(batcher.enqueue(pools.slice(0, 2), 1_000), 1_300);
  assert.equal(batcher.flush(1_299).length, 0);
  assert.equal(batcher.flush(1_300).length, 1);
  assert.equal(batcher.shouldRefresh(46_300), true);
});

test('unstable or stale Level 1 cannot arm, and anchor lifecycle controls refresh', () => {
  const parsed = parseLevel1Snapshot(raw(), pool, 10_000);
  assert.equal(parsed.status, 'complete');
  if (parsed.status !== 'complete') return;
  const unstable = { ...parsed.snapshot, poolStatus: 'unstable' as const };
  assert.equal(canEnterArmed(unstable, 10_000, 45).status, 'rejected');
  assert.equal(
    shouldContinueLevel1({ status: 'armed', anchorDelivered: false, anchorOutboxExpired: false }),
    true,
  );
  assert.equal(
    shouldContinueLevel1({
      status: 'confirmed-pending-anchor',
      anchorDelivered: true,
      anchorOutboxExpired: false,
    }),
    false,
  );
  assert.equal(
    shouldContinueLevel1({
      status: 'confirmed-pending-anchor',
      anchorDelivered: false,
      anchorOutboxExpired: true,
    }),
    false,
  );
  assert.deepEqual(transitionLevel1State('qualified', parsed.snapshot, 10_000, 45), {
    state: 'armed',
  });
  assert.equal(transitionLevel1State('armed', unstable, 10_000, 45).state, 'incomplete');
});
