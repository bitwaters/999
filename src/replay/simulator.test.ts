import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfigText } from '../config/load.js';
import type { ReplayEvidence } from './timeline.js';
import { simulateReplay } from './simulator.js';

const base = parseConfigText(
  readFileSync(new URL('../../config/bot.yaml', import.meta.url), 'utf8'),
).config;

function replayConfig() {
  const config = structuredClone(base);
  config.chains.sol.safety.freshness_seconds = 600;
  config.chains.sol.level1.buyers_freshness_seconds = 600;
  config.chains.sol.newborn.min_absolute = { buys: 0, buyers: 0, volume_usd: 0 };
  config.chains.sol.newborn.min_rate_per_second = { buys: 0, buyers: 0, volume_usd: 0 };
  config.strategies.emerging_breakout.conviction = {
    min_net_buy_usd: 0,
    min_buy_volume_share: 0,
    min_buyers: 0,
  };
  config.strategies.emerging_breakout.organic_growth = {
    max_top1_share: 1,
    max_top3_share: 1,
  };
  config.strategies.emerging_breakout.entry_quality = {
    min_reserve_usd: 0,
    max_price_extension: 1,
    max_pre_send_drift: 1,
  };
  config.outcomes.horizons_seconds = [60];
  return config;
}

const token = 'So11111111111111111111111111111111111111112';
const pool = 'pool';
const quote = 'quote';
const discovery = [
  {
    chain: 'sol' as const,
    tokenAddress: token,
    source: 'trending_1m' as const,
    observedAt: 1_000,
    rank: 10,
  },
  {
    chain: 'sol' as const,
    tokenAddress: token,
    source: 'trending_1m' as const,
    observedAt: 2_000,
    rank: 5,
  },
];

function tokenPoolPayload() {
  return {
    data: [
      {
        type: 'token',
        id: `solana_${token}`,
        attributes: { address: token },
        relationships: { top_pools: { data: [{ type: 'pool', id: `solana_${pool}` }] } },
      },
    ],
    included: [level1PoolItem('0.9')],
  };
}

function level1PoolItem(price: string) {
  return {
    type: 'pool',
    id: `solana_${pool}`,
    attributes: {
      address: pool,
      reserve_in_usd: '20000',
      pool_created_at: '1970-01-01T00:00:00.000Z',
      base_token_price_usd: price,
      quote_token_price_usd: '1',
      base_token_balance: '10000',
      quote_token_balance: '20000',
      volume_usd: { m5: '5000', m15: '5000', m30: '5000', h24: '10000' },
      buy_volume_usd: { m5: '3500', m15: '3500', m30: '3500' },
      sell_volume_usd: { m5: '1500', m15: '1500', m30: '1500' },
      net_buy_volume_usd: { m5: '2000', m15: '2000', m30: '2000' },
      transactions: {
        m5: { buys: 10, sells: 2, buyers: 10, sellers: 2 },
        m15: { buys: 10, sells: 2, buyers: 10, sellers: 2 },
        m30: { buys: 10, sells: 2, buyers: 10, sellers: 2 },
        h24: { buys: 100, sells: 20 },
      },
    },
    relationships: {
      base_token: { data: { id: `solana_${token}` } },
      quote_token: { data: { id: `solana_${quote}` } },
    },
  };
}

function evidence(): ReplayEvidence[] {
  return [
    {
      kind: 'safety',
      chain: 'sol',
      tokenAddress: token,
      observedAt: 2_000,
      payload: { renounced_mint: true, renounced_freeze_account: true },
    },
    { kind: 'pool', chain: 'sol', observedAt: 3_000, payload: tokenPoolPayload() },
    { kind: 'level1', chain: 'sol', observedAt: 4_000, payload: { data: [level1PoolItem('0.9')] } },
    {
      kind: 'trades',
      chain: 'sol',
      tokenAddress: token,
      poolAddress: pool,
      observedAt: 5_000,
      payload: { data: [{ attributes: { block_timestamp: '1970-01-01T00:00:04.000Z' } }] },
    },
    { kind: 'level1', chain: 'sol', observedAt: 40_000, payload: { data: [level1PoolItem('1')] } },
    {
      kind: 'trades',
      chain: 'sol',
      tokenAddress: token,
      poolAddress: pool,
      observedAt: 41_000,
      payload: { data: [{ attributes: { block_timestamp: '1970-01-01T00:00:40.000Z' } }] },
    },
    {
      kind: 'g2',
      chain: 'sol',
      poolAddress: pool,
      observedAt: 31_000,
      payload: { c: 'G2', n: 'solana', pa: pool, ty: 'b', t: 20_000, to: '100', toq: '2000' },
    },
    {
      kind: 'g2',
      chain: 'sol',
      poolAddress: pool,
      observedAt: 61_000,
      payload: { c: 'G2', n: 'solana', pa: pool, ty: 'b', t: 50_000, to: '100', toq: '2000' },
    },
    {
      kind: 'g2',
      chain: 'sol',
      poolAddress: pool,
      observedAt: 70_000,
      payload: { c: 'G2', n: 'solana', pa: pool, ty: 'b', t: 69_000, to: '100', toq: '2100' },
    },
  ];
}

test('replay re-runs raw safety, pool, Level 1, ACE, dispatch and entry without live tables', () => {
  const results = simulateReplay({
    config: replayConfig(),
    configVersionId: 7,
    dataStartAt: 60_000,
    dataEndAt: 61_000,
    dataCutoffAt: 140_000,
    deliveryDelayMs: 5_000,
    discovery,
    evidence: evidence(),
  });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.simulatedSignal.status, 'delivered');
  assert.equal(results[0]!.completenessStatus, 'partial');
  assert.equal((results[0]!.outcome.execution as { status: string }).status, 'executable');
  assert.equal((results[0]!.outcome.entry as { observedAt: number }).observedAt, 70_000);
  assert.equal(
    (results[0]!.simulatedSignal.snapshot as { age: { status: string } }).age.status,
    'pass',
  );
});

test('replay data end blocks later confirmations while cutoff still supplies outcome evidence', () => {
  const results = simulateReplay({
    config: replayConfig(),
    configVersionId: 7,
    dataStartAt: 60_000,
    dataEndAt: 60_999,
    dataCutoffAt: 140_000,
    deliveryDelayMs: 5_000,
    discovery,
    evidence: evidence(),
  });
  assert.equal(results[0]!.simulatedSignal.status, 'blocked');
  assert.equal(results[0]!.completenessStatus, 'partial');
});

test('replay warmup seeds cooldown without emitting a pre-window signal', () => {
  const config = replayConfig();
  config.chains.sol.discovery.candidate_ttl_seconds = 90;
  config.strategies.emerging_breakout.cooldown_seconds = 300;
  const observations = [
    ...discovery,
    {
      chain: 'sol' as const,
      tokenAddress: token,
      source: 'trending_1m' as const,
      observedAt: 100_000,
      rank: 10,
    },
    {
      chain: 'sol' as const,
      tokenAddress: token,
      source: 'trending_1m' as const,
      observedAt: 101_000,
      rank: 5,
    },
  ];
  const later: ReplayEvidence[] = [
    {
      kind: 'safety',
      chain: 'sol',
      tokenAddress: token,
      observedAt: 101_000,
      payload: { renounced_mint: true, renounced_freeze_account: true },
    },
    { kind: 'pool', chain: 'sol', observedAt: 102_000, payload: tokenPoolPayload() },
    { kind: 'level1', chain: 'sol', observedAt: 103_000, payload: { data: [level1PoolItem('1')] } },
    {
      kind: 'trades',
      chain: 'sol',
      tokenAddress: token,
      poolAddress: pool,
      observedAt: 104_000,
      payload: { data: [{ attributes: { block_timestamp: '1970-01-01T00:01:44.000Z' } }] },
    },
    {
      kind: 'level1',
      chain: 'sol',
      observedAt: 140_000,
      payload: { data: [level1PoolItem('1.05')] },
    },
    {
      kind: 'trades',
      chain: 'sol',
      tokenAddress: token,
      poolAddress: pool,
      observedAt: 141_000,
      payload: { data: [{ attributes: { block_timestamp: '1970-01-01T00:02:20.000Z' } }] },
    },
    {
      kind: 'g2',
      chain: 'sol',
      poolAddress: pool,
      observedAt: 151_000,
      payload: { c: 'G2', n: 'solana', pa: pool, ty: 'b', t: 140_000, to: '100', toq: '2000' },
    },
  ];
  const results = simulateReplay({
    config,
    configVersionId: 7,
    dataStartAt: 100_000,
    dataEndAt: 160_000,
    dataCutoffAt: 200_000,
    deliveryDelayMs: 5_000,
    discovery: observations,
    evidence: [...evidence(), ...later],
  });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.simulatedSignal.status, 'blocked');
  assert.ok(
    (results[0]!.simulatedSignal.reasons as string[]).includes('cooldown:anchor'),
    JSON.stringify(results[0]!.simulatedSignal),
  );
});

test('replay marks missing historical G2 unavailable instead of inventing a signal', () => {
  const results = simulateReplay({
    config: replayConfig(),
    configVersionId: 7,
    dataCutoffAt: 140_000,
    deliveryDelayMs: 5_000,
    discovery,
    evidence: evidence().filter((item) => item.kind !== 'g2'),
  });
  assert.equal(results[0]!.completenessStatus, 'unavailable');
  assert.equal(results[0]!.simulatedSignal.reason, 'g2:unavailable');
});

test('replay parameter changes re-run conviction instead of reusing a live decision', () => {
  const config = replayConfig();
  config.strategies.emerging_breakout.conviction.min_net_buy_usd = 9_999;
  const results = simulateReplay({
    config,
    configVersionId: 8,
    dataStartAt: 60_000,
    dataCutoffAt: 140_000,
    deliveryDelayMs: 5_000,
    discovery,
    evidence: evidence(),
  });
  assert.equal(results[0]!.simulatedSignal.status, 'blocked');
  assert.equal(results[0]!.completenessStatus, 'full');
  assert.ok((results[0]!.simulatedSignal.reasons as string[]).includes('conviction:rejected'));
});

test('adaptive admission replay is deterministic for the same raw timeline and cutoff', () => {
  const input = {
    config: replayConfig(),
    configVersionId: 7,
    dataStartAt: 60_000,
    dataEndAt: 61_000,
    dataCutoffAt: 140_000,
    deliveryDelayMs: 5_000,
    discovery,
    evidence: evidence(),
  };
  assert.deepEqual(simulateReplay(input), simulateReplay(input));
});
