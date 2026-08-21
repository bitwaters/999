import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CandidateCycleTracker,
  canCreateSignal,
  isAnchorCooldownActive,
  runCheapPreFilter,
  unresolvedRetryAt,
} from './candidate.js';

const safety = (status: 'pass' | 'fatal' | 'policy_reject' | 'incomplete') => ({
  status,
  reasons: [],
  checkedAt: 0,
  expiresAt: 10_000,
  providerEventId: 'event',
  configVersionId: 'config',
  canonical: {},
});

test('Candidate Cycle merges sources and only triggers first appearance or improvement', () => {
  const tracker = new CandidateCycleTracker(900);
  const first = tracker.ingest({
    chain: 'sol',
    tokenAddress: 'token',
    source: 'trending_1m',
    observedAt: 1_000,
    rank: 10,
  });
  assert.equal(first.triggered, true);
  assert.equal(first.startedNewCycle, true);
  assert.equal(
    tracker.ingest({
      chain: 'sol',
      tokenAddress: 'token',
      source: 'trending_1m',
      observedAt: 2_000,
      rank: 10,
    }).triggered,
    false,
  );
  assert.equal(
    tracker.ingest({
      chain: 'sol',
      tokenAddress: 'token',
      source: 'trending_1m',
      observedAt: 3_000,
      rank: 8,
    }).triggered,
    true,
  );
  assert.equal(
    tracker.ingest({
      chain: 'sol',
      tokenAddress: 'token',
      source: 'hot_searches',
      observedAt: 4_000,
      visitingCount: 10,
    }).triggered,
    true,
  );
  assert.equal(tracker.get('sol', 'token')?.evidence.length, 4);
});

test('Candidate Cycle closes after discovery TTL and then starts a new cycle', () => {
  const tracker = new CandidateCycleTracker(10);
  tracker.ingest({
    chain: 'bsc',
    tokenAddress: 'token',
    source: 'trending_5m',
    observedAt: 1_000,
    rank: 1,
  });
  const closed = tracker.closeExpired(11_001);
  assert.equal(closed.length, 1);
  assert.ok(closed[0]);
  assert.equal(closed[0].status, 'expired');
  const next = tracker.ingest({
    chain: 'bsc',
    tokenAddress: 'token',
    source: 'trending_5m',
    observedAt: 12_000,
    rank: 1,
  });
  assert.equal(next.startedNewCycle, true);
  assert.equal(next.cycle.cycleStartedAt, 12_000);
});

test('cheap prefilter is safety-first and unresolved pools receive bounded backoff', () => {
  const base = {
    chain: 'sol' as const,
    tokenAddress: 'token',
    safety: safety('pass'),
    marketCapUsd: { state: 'complete' as const, value: '1000' },
    liquidityUsd: { state: 'complete' as const, value: '500' },
    minMarketCapUsd: '900',
    minLiquidityUsd: '400',
    attentionProgress: true,
  };
  assert.equal(runCheapPreFilter(base).status, 'pass');
  assert.equal(runCheapPreFilter({ ...base, safety: safety('fatal') }).status, 'rejected');
  assert.equal(
    runCheapPreFilter({ ...base, liquidityUsd: { state: 'missing' } }).status,
    'incomplete',
  );
  assert.equal(runCheapPreFilter({ ...base, attentionProgress: false }).status, 'rejected');
  assert.equal(unresolvedRetryAt(1_000, 0, 30, 300), 31_000);
  assert.equal(unresolvedRetryAt(1_000, 1, 30, 300), 61_000);
  assert.equal(unresolvedRetryAt(1_000, 10, 30, 300), 301_000);
  assert.equal(isAnchorCooldownActive(2_000, 1_999), true);
  assert.equal(isAnchorCooldownActive(2_000, 2_000), false);
  assert.equal(canCreateSignal('sol', 'token', 1_999, 2_000).status, 'rejected');
  assert.equal(canCreateSignal('sol', 'token', 2_000, 2_000).status, 'pass');
});
