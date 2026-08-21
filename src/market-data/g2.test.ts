import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateG2Window,
  G2IngestQueue,
  G2SubscriptionManager,
  hashG2Message,
  normalizeG2Item,
  TradeDeduper,
} from './g2.js';
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

const raw = (side: 'buy' | 'sell', itemIndex = 0) => ({
  c: 'G2',
  n: 'solana',
  pa: 'pool',
  ty: side,
  t: 1_000,
  to: '10',
  toq: '100',
  trade_id: `trade-${itemIndex}`,
  item_index: itemIndex,
});

test('G2 normalizer converts quote-side direction and preserves item legs', () => {
  const quotePool = { ...pool, targetSide: 'quote' as const };
  const parsed = normalizeG2Item(raw('buy'), quotePool, 1_100);
  assert.equal(parsed.status, 'complete');
  if (parsed.status === 'complete') {
    assert.equal(parsed.trade.targetSide, 'sell');
    assert.equal(parsed.trade.observedAt, 1_100);
    assert.equal(parsed.trade.itemIndex, 0);
  }
  assert.equal(
    normalizeG2Item({ ...raw('buy'), to: 'not-a-number' }, pool, 1_100).status,
    'invalid',
  );
});

test('G2 normalizer accepts the live compact side and numeric amount encoding', () => {
  const buy = normalizeG2Item(
    { ...raw('buy'), ty: 'b', t: 1_000, to: 1.25, toq: 100 },
    pool,
    1_100,
  );
  const sell = normalizeG2Item(
    { ...raw('sell'), ty: 's', t: 1_000, to: 1.25, toq: 100 },
    pool,
    1_100,
  );
  assert.equal(buy.status, 'complete');
  assert.equal(sell.status, 'complete');
  if (buy.status === 'complete' && sell.status === 'complete') {
    assert.equal(buy.trade.rawSide, 'buy');
    assert.equal(sell.trade.rawSide, 'sell');
    assert.equal(buy.trade.tokenAmount, '1.25');
    assert.equal(buy.trade.quoteAmount, '100');
  }
});

test('trade deduplication distinguishes exact replay from ambiguous collision', () => {
  const first = normalizeG2Item(raw('buy'), pool, 1_100);
  assert.equal(first.status, 'complete');
  if (first.status !== 'complete') return;
  const deduper = new TradeDeduper();
  assert.equal(deduper.ingest('message-1', [first.trade]).trades[0]?.dedupStatus, 'unique');
  assert.equal(deduper.ingest('message-1', [first.trade]).duplicateMessage, true);
  const conflicting = { ...first.trade, quoteAmount: '101', fingerprint: 'different' };
  const result = deduper.ingest('message-2', [conflicting]);
  assert.equal(result.trades[0]?.ambiguityStatus, 'ambiguous');
  assert.match(hashG2Message({ c: 'G2' }), /^[a-f0-9]{64}$/u);
});

test('G2 window aggregates net buy, share and concentration without using duplicates', () => {
  const buy = normalizeG2Item(raw('buy', 0), pool, 1_100);
  const sell = normalizeG2Item(raw('sell', 1), pool, 1_100);
  assert.equal(buy.status, 'complete');
  assert.equal(sell.status, 'complete');
  if (buy.status !== 'complete' || sell.status !== 'complete') return;
  const window = aggregateG2Window([buy.trade, sell.trade], 0, 2_000, 2_000);
  assert.equal(window.status, 'complete');
  assert.equal(window.netBuyUsd, '0');
  assert.equal(window.buyVolumeShare, '0.5');
  assert.equal(window.top1BuyShare, '1');
});

test('G2 window fail-closes malformed persisted decimals without crashing the runtime', () => {
  const parsed = normalizeG2Item(raw('buy'), pool, 1_100);
  assert.equal(parsed.status, 'complete');
  if (parsed.status !== 'complete') return;
  const window = aggregateG2Window(
    [{ ...parsed.trade, quoteAmount: 'not-a-decimal' }],
    0,
    2_000,
    2_000,
  );
  assert.equal(window.status, 'incomplete');
});

test('G2 subscription manager is Armed-only and reconnects desired subscriptions', () => {
  const manager = new G2SubscriptionManager(1);
  assert.equal(manager.request(pool, 'confirmed-pending-anchor'), 'rejected_capacity');
  assert.equal(manager.request(pool, 'armed'), 'subscribe');
  assert.equal(
    manager.request({ ...pool, poolAddress: 'other', identityKey: 'sol:other:token' }, 'armed'),
    'rejected_capacity',
  );
  manager.connect();
  assert.equal(manager.confirm(pool.identityKey), true);
  manager.disconnect();
  assert.deepEqual(manager.reconnectPlan(), [pool.identityKey]);
  manager.connect();
  assert.equal(manager.unset(pool.identityKey), true);
});

test('G2 queue keeps callback observedAt and marks hard-limit windows incomplete', () => {
  let highWatermarkEvents = 0;
  let hardLimitEvents = 0;
  const queue = new G2IngestQueue<string>(3, 2, 3, {
    onHighWatermark: () => {
      highWatermarkEvents += 1;
    },
    onHardLimit: () => {
      hardLimitEvents += 1;
    },
  });
  assert.equal(queue.enqueue('a', 1_000, 1).accepted, true);
  assert.equal(queue.enqueue('b', 1_001, 2).accepted, true);
  assert.equal(queue.atHighWatermark(), true);
  assert.equal(highWatermarkEvents, 1);
  assert.equal(queue.enqueue('c', 1_002, 0).accepted, true);
  assert.deepEqual(queue.enqueue('d', 1_003, 0), { accepted: false, hardLimit: true });
  assert.equal(hardLimitEvents, 1);
  assert.equal(queue.dropLowestPriority()?.value, 'c');
  assert.equal(queue.integrity().status, 'incomplete');
  assert.deepEqual(
    queue.drain(2).map((item) => item.observedAt),
    [1_000, 1_001],
  );
});
