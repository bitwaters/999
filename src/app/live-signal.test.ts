import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfigText } from '../config/load.js';
import { evaluateSolSafety } from '../domain/safety.js';
import { openDatabase } from '../persistence/db.js';
import type { Level1Snapshot } from '../market-data/level1.js';
import type { G2Window } from '../market-data/g2.js';
import type { CanonicalPool } from '../market-data/pools.js';
import type { CandidateCycle } from '../pipeline/candidate.js';
import { createLiveSignal } from './live-signal.js';

const config = parseConfigText(
  readFileSync(new URL('../../config/bot.yaml', import.meta.url), 'utf8'),
).config;
const pool: CanonicalPool = {
  chain: 'sol',
  poolAddress: 'pool',
  tokenAddress: 'token',
  baseTokenAddress: 'token',
  quoteTokenAddress: 'quote',
  targetSide: 'base',
  reserveUsd: '20000',
  volumeUsd24h: '5000',
  trades24h: 100,
  poolCreatedAt: 1,
  restSupported: true,
  g2Supported: true,
  identityKey: 'sol:pool:token',
};
const level1: Level1Snapshot = {
  chain: 'sol',
  poolAddress: 'pool',
  tokenAddress: 'token',
  observedAt: 29_000,
  dataState: 'complete',
  poolStatus: 'stable',
  reserveUsd: '20000',
  priceUsd: '1',
  buys: 10,
  sells: 2,
  buyers: 10,
  sellers: 2,
  volumeUsd: '2000',
  netBuyUsd: '1500',
  poolAgeSeconds: 120,
  lastTradeAt: 29_000,
  windows: {
    m5: { state: 'partial', coverageSeconds: 120, buys: 10, buyers: 10, volumeUsd: '2000' },
  },
};
const g2: G2Window = {
  status: 'complete',
  windowStart: 0,
  windowEnd: 30_000,
  coverageSeconds: 30,
  lateCount: 0,
  duplicateCount: 0,
  ambiguousCount: 0,
  buyVolumeUsd: '2000',
  sellVolumeUsd: '500',
  netBuyUsd: '1500',
  buyVolumeShare: '0.8',
  top1BuyShare: '0.2',
  top3BuyShare: '0.5',
};
const cycle: CandidateCycle = {
  key: 'sol:token',
  chain: 'sol',
  tokenAddress: 'token',
  cycleStartedAt: 1,
  firstSeenAt: 1,
  lastSeenAt: 29_000,
  status: 'scouting',
  evidence: [
    { chain: 'sol', tokenAddress: 'token', source: 'trending_1m', observedAt: 1, rank: 10 },
    { chain: 'sol', tokenAddress: 'token', source: 'trending_1m', observedAt: 2, rank: 5 },
  ],
};

function database() {
  const database = openDatabase(':memory:');
  database
    .prepare(
      `INSERT INTO rule_config_versions (config_hash, git_commit, run_mode, yaml_snapshot, created_at)
       VALUES ('hash', 'commit', 'shadow', 'yaml', 1)`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO candidates
       (chain, token_address, cycle_started_at, first_seen_at, last_seen_at, status, pool_address,
        safety_status, safety_json, funnel_status, config_version_id, updated_at)
       VALUES ('sol', 'token', 1, 1, 29000, 'armed', 'pool', 'pass', ?, 'armed', 1, 29000)`,
    )
    .run(
      JSON.stringify(
        evaluateSolSafety(
          { renounced_mint: true, renounced_freeze_account: true },
          config.chains.sol.safety,
          { checkedAt: 1, providerEventId: 'event', configVersionId: '1' },
        ),
      ),
    );
  return database;
}

test('live signal coordinator atomically creates one signal and its enabled ENTRY outbox', () => {
  const db = database();
  const safety = evaluateSolSafety(
    { renounced_mint: true, renounced_freeze_account: true },
    config.chains.sol.safety,
    { checkedAt: 1, providerEventId: 'event', configVersionId: '1' },
  );
  const result = createLiveSignal({
    config,
    database: db,
    writeBudget: { maxRows: 20, maxMs: 100 },
    configVersionId: 1,
    candidateId: 1,
    cycle,
    safety,
    pool,
    level1,
    previousLevel1: { ...level1, observedAt: 28_000, priceUsd: '0.9' },
    g2,
    attention: { status: 'pass', reasons: [] },
    confirmedAt: 30_000,
  });
  assert.equal(result.status, 'created');
  if (result.status === 'created') {
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM signals').get() as { count: number }).count,
      1,
    );
    assert.equal(
      (
        db
          .prepare('SELECT COUNT(*) AS count FROM delivery_outbox WHERE signal_id = ?')
          .get(result.signalId) as { count: number }
      ).count,
      1,
    );
    assert.equal(
      (db.prepare('SELECT status FROM candidates WHERE id = 1').get() as { status: string }).status,
      'confirmed-pending-anchor',
    );
  }
  db.close();
});

test('live signal coordinator blocks without a price baseline', () => {
  const db = database();
  const result = createLiveSignal({
    config,
    database: db,
    writeBudget: { maxRows: 20, maxMs: 100 },
    configVersionId: 1,
    candidateId: 1,
    cycle,
    safety: evaluateSolSafety(
      { renounced_mint: true, renounced_freeze_account: true },
      config.chains.sol.safety,
      { checkedAt: 1, providerEventId: 'event', configVersionId: '1' },
    ),
    pool,
    level1,
    g2,
    attention: { status: 'pass', reasons: [] },
    confirmedAt: 30_000,
  });
  assert.deepEqual(result, {
    status: 'blocked',
    reasons: ['entry_quality:missing_price_baseline'],
  });
  db.close();
});
