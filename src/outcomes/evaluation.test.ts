import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeG2Item } from '../market-data/g2.js';
import type { CanonicalPool } from '../market-data/pools.js';
import {
  CandleRevisionStore,
  evaluateExecution,
  evaluateHorizon,
  selectEntry,
} from './evaluation.js';

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

const trade = (time: number, id: string, quote = '100') => {
  const parsed = normalizeG2Item(
    {
      c: 'G2',
      n: 'solana',
      pa: 'pool',
      ty: 'buy',
      t: time,
      to: '10',
      toq: quote,
      vo: quote,
      trade_id: id,
    },
    pool,
    time + 5,
  );
  assert.equal(parsed.status, 'complete');
  if (parsed.status !== 'complete') throw new Error('fixture');
  return parsed.trade;
};

const candle = (openTime: number, observedAt: number, closePrice = '1', revision = 0) => ({
  chain: 'sol' as const,
  poolAddress: 'pool',
  tokenAddress: 'token',
  targetSide: 'base' as const,
  intervalSeconds: 30 as const,
  openTime,
  revision,
  observedAt,
  isClosed: true,
  openPrice: '1',
  highPrice: '1.2',
  lowPrice: '0.9',
  closePrice,
  volume: '100',
});

test('entry selection uses same identity, anchor time and earliest observed trade', () => {
  const result = selectEntry({
    trades: [
      trade(1_010, 'late'),
      trade(1_005, 'early'),
      { ...trade(1_002, 'other'), poolAddress: 'other' },
    ],
    chain: 'sol',
    poolAddress: 'pool',
    tokenAddress: 'token',
    anchorDeliveredAt: 1_000,
    now: 2_000,
    entryTimeoutSeconds: 60,
    maxTransportDelaySeconds: 10,
    maxFutureSkewSeconds: 2,
    anchorToleranceSeconds: 2,
  });
  assert.equal(result.status, 'executable');
  if (result.status === 'executable') assert.equal(result.trade.providerTradeId, 'early');
  assert.equal(
    evaluateExecution({
      entry: result,
      g2CoverageComplete: true,
      restCoverageComplete: true,
      restConflict: false,
    }).status,
    'executable',
  );
  assert.equal(
    evaluateExecution({
      entry: result,
      g2CoverageComplete: false,
      restCoverageComplete: true,
      restConflict: false,
    }).status,
    'incomplete',
  );
  assert.equal(
    evaluateExecution({
      entry: result,
      g2CoverageComplete: true,
      restCoverageComplete: true,
      restConflict: true,
    }).status,
    'incomplete',
  );
});

test('entry timeout distinguishes no data from complete non-executable coverage', () => {
  const noEntry = selectEntry({
    trades: [],
    chain: 'sol',
    poolAddress: 'pool',
    tokenAddress: 'token',
    anchorDeliveredAt: 1_000,
    now: 62_000,
    entryTimeoutSeconds: 60,
    maxTransportDelaySeconds: 10,
    maxFutureSkewSeconds: 2,
    anchorToleranceSeconds: 2,
  });
  assert.equal(noEntry.status, 'not_found');
  assert.equal(
    evaluateExecution({
      entry: noEntry,
      g2CoverageComplete: true,
      restCoverageComplete: true,
      restConflict: false,
    }).status,
    'not_executable',
  );
  assert.equal(
    evaluateExecution({
      entry: noEntry,
      g2CoverageComplete: false,
      restCoverageComplete: true,
      restConflict: false,
    }).status,
    'incomplete',
  );
});

test('ambiguous or duplicate trades are never selected as entry', () => {
  const ambiguous = { ...trade(1_005, 'ambiguous'), ambiguityStatus: 'ambiguous' as const };
  const duplicate = { ...trade(1_006, 'duplicate'), dedupStatus: 'duplicate' as const };
  const result = selectEntry({
    trades: [ambiguous, duplicate],
    chain: 'sol',
    poolAddress: 'pool',
    tokenAddress: 'token',
    anchorDeliveredAt: 1_000,
    now: 62_000,
    entryTimeoutSeconds: 60,
    maxTransportDelaySeconds: 10,
    maxFutureSkewSeconds: 2,
    anchorToleranceSeconds: 2,
  });
  assert.deepEqual(result, { status: 'incomplete', reason: 'entry:ambiguous_duplicate' });
});

test('candle revisions are append-only and horizon uses cutoff-limited latest revision', () => {
  const store = new CandleRevisionStore();
  assert.equal(store.ingest(candle(60_000, 61_000)).action, 'inserted');
  assert.equal(store.ingest(candle(60_000, 61_000)).action, 'deduped');
  assert.equal(store.ingest(candle(60_000, 62_000, '1.1')).action, 'revision');
  const identity = 'sol:pool:token:base:30:60000';
  assert.equal(store.latestAtCutoff(identity, 61_500)?.closePrice, '1');
  assert.equal(store.latestAtCutoff(identity, 62_000)?.closePrice, '1.1');
  assert.throws(
    () => store.ingest({ ...candle(90_000, 91_000), highPrice: '0.8' }),
    /Invalid OHLC relationship/,
  );
});

test('horizon uses only fixed-time close and rejects incomplete entry-partial coverage', () => {
  const complete = evaluateHorizon({
    anchorDeliveredAt: 0,
    horizonSeconds: 60,
    outcomeMaxLatenessSeconds: 5,
    entry: { observedAt: 10_000, priceUsd: '1' },
    candles: [candle(30_000, 60_000, '1.1'), candle(60_000, 65_000, '1.2')],
    entryPartial: { highPrice: '1.05', lowPrice: '0.95', complete: true },
  });
  assert.equal(complete.status, 'complete');
  if (complete.status === 'complete') assert.equal(complete.forwardReturn, '0.1');
  const partial = evaluateHorizon({
    anchorDeliveredAt: 0,
    horizonSeconds: 60,
    outcomeMaxLatenessSeconds: 5,
    entry: { observedAt: 10_000, priceUsd: '1' },
    candles: [candle(30_000, 60_000, '1.1'), candle(60_000, 65_000, '1.2')],
    entryPartial: { highPrice: '1.05', lowPrice: '0.95', complete: false },
  });
  assert.equal(partial.status, 'incomplete');
  const late = evaluateHorizon({
    anchorDeliveredAt: 0,
    horizonSeconds: 60,
    outcomeMaxLatenessSeconds: 5,
    entry: { observedAt: 61_000, priceUsd: '1' },
    candles: [],
  });
  assert.equal(late.status, 'late_entry');
});
