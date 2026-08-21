import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  armedSubscriptionsToRelease,
  canArmG2Candidate,
  evaluateCandidateAttention,
  expireStaleCandidateRows,
  g2ProbeState,
  latestLevel1ObservedAt,
  level1ProbeState,
  isConfirmationWindowUsable,
  refreshConfirmationEvidence,
  selectArmCandidateRows,
  selectLevel1CandidateRows,
  selectPoolResolutionRows,
  shouldRefreshConfirmationEvidence,
  sameChainAddress,
  shouldRearmG2Candidate,
} from './provider-probe.js';
import { openDatabase } from '../persistence/db.js';
import type { SafetyResult } from '../domain/safety.js';
import type { Level1Snapshot } from '../market-data/level1.js';

test('security refresh address matching is chain-specific', () => {
  assert.equal(sameChainAddress('bsc', '0xABC', '0xabc'), true);
  assert.equal(sameChainAddress('sol', 'AbC', 'abc'), false);
  assert.equal(sameChainAddress('sol', 'AbC', 'AbC'), true);
});

test('confirmation refresh reuses only the just-closed G2 window', () => {
  assert.equal(isConfirmationWindowUsable(60_100, 60_000), true);
  assert.equal(isConfirmationWindowUsable(90_000, 60_000), true);
  assert.equal(isConfirmationWindowUsable(90_001, 60_000), false);
  assert.equal(isConfirmationWindowUsable(59_999, 60_000), false);
});

test('Level 1 evidence observedAt covers the later pool and trades responses', () => {
  assert.equal(latestLevel1ObservedAt(1_000, 1_250), 1_250);
  assert.equal(latestLevel1ObservedAt(1_250, 1_000), 1_250);
  assert.throws(() => latestLevel1ObservedAt(1_000, -1), /Invalid Level 1 evidence timestamp/);
});

test('G2 is healthy when no candidate currently requires an active socket', () => {
  assert.equal(g2ProbeState(undefined, false), 'ok');
  assert.equal(g2ProbeState('unknown', false), 'unknown');
  assert.equal(g2ProbeState('failed', false), 'failed');
  assert.equal(g2ProbeState(undefined, true), 'failed');
});

test('Level 1 provider health tolerates candidate-local gaps but fails when none parse', () => {
  assert.equal(level1ProbeState(0, 0), 'unknown');
  assert.equal(level1ProbeState(50, 43), 'ok');
  assert.equal(level1ProbeState(50, 0), 'failed');
  assert.throws(() => level1ProbeState(1, 2), /Invalid Level 1 probe counts/);
});

test('confirmation refresh only runs for refreshable evidence gaps', () => {
  assert.equal(
    shouldRefreshConfirmationEvidence(['level1:stale', 'conviction:incomplete']),
    true,
  );
  assert.equal(
    shouldRefreshConfirmationEvidence([
      'safety:not_fresh_or_config_mismatch',
      'entryQuality:rejected',
    ]),
    false,
  );
  assert.equal(
    shouldRefreshConfirmationEvidence(['level1:stale', 'attention:rejected']),
    false,
  );
  assert.equal(
    shouldRefreshConfirmationEvidence(['level1:stale', 'entryQuality:rejected']),
    false,
  );
  assert.equal(shouldRefreshConfirmationEvidence(['level1:stale', 'age:rejected:no_data']), false);
  assert.equal(
    shouldRefreshConfirmationEvidence(['level1:stale', 'g2:zero', 'evidence:incomplete']),
    false,
  );
  assert.equal(
    shouldRefreshConfirmationEvidence(['entry_quality:missing_price_baseline']),
    false,
  );
});

test('confirmation refresh validates safety before spending CoinGecko work', async () => {
  let level1Calls = 0;
  const order: string[] = [];
  const blocked = await refreshConfirmationEvidence({
    now: () => 200,
    configVersionId: '1',
    refreshSafety: async () => {
      order.push('safety');
      return safetyAt('fatal', 200, 260);
    },
    refreshLevel1: async () => {
      order.push('level1');
      level1Calls += 1;
      return {} as Level1Snapshot;
    },
  });
  assert.equal(blocked.status, 'blocked');
  assert.equal(level1Calls, 0);
  assert.deepEqual(order, ['safety']);

  const level1 = { observedAt: 205 } as Level1Snapshot;
  const refreshed = await refreshConfirmationEvidence({
    now: () => 205,
    configVersionId: '1',
    refreshSafety: async () => {
      order.push('safety');
      return safetyAt('pass', 200, 260);
    },
    refreshLevel1: async () => {
      order.push('level1');
      level1Calls += 1;
      return level1;
    },
  });
  assert.equal(refreshed.status, 'complete');
  assert.equal(level1Calls, 1);
  assert.deepEqual(order, ['safety', 'safety', 'level1']);
});

test('G2 re-arms persisted candidates after a process restart', () => {
  assert.equal(shouldRearmG2Candidate('armed', 'armed'), true);
  assert.equal(shouldRearmG2Candidate('scouting', 'level1_checked'), true);
  assert.equal(shouldRearmG2Candidate('scouting', 'armed'), false);
  assert.equal(shouldRearmG2Candidate('expired', 'armed'), false);
});

test('persisted Armed candidates do not require a new Attention increase to rearm', () => {
  assert.equal(canArmG2Candidate('armed', 'armed', 'incomplete'), true);
  assert.equal(canArmG2Candidate('armed', 'armed', 'rejected'), true);
  assert.equal(canArmG2Candidate('scouting', 'level1_checked', 'incomplete'), false);
  assert.equal(canArmG2Candidate('expired', 'armed', 'pass'), false);
});

test('G2 reconciliation releases obsolete Armed pools but preserves pending anchors', () => {
  const active = new Map<string, 'armed' | 'confirmed-pending-anchor'>([
    ['bsc:old:token', 'armed'],
    ['bsc:keep:token', 'armed'],
    ['sol:anchor:token', 'confirmed-pending-anchor'],
  ]);
  assert.deepEqual(
    armedSubscriptionsToRelease(active, new Set(['bsc:keep:token'])),
    ['bsc:old:token'],
  );
});

test('candidate Attention accepts improvement from any allowed discovery source', () => {
  const attentionConfig = {
    max_rank: 20,
    min_rank_improvement: 1,
    min_hot_search_growth: 1,
  } as const;
  const evidence = [
    {
      chain: 'bsc' as const,
      tokenAddress: '0x1',
      source: 'trending_1m' as const,
      observedAt: 1,
      rank: 12,
    },
    {
      chain: 'bsc' as const,
      tokenAddress: '0x1',
      source: 'trending_1m' as const,
      observedAt: 2,
      rank: 6,
    },
    {
      chain: 'bsc' as const,
      tokenAddress: '0x1',
      source: 'hot_searches' as const,
      observedAt: 3,
      visitingCount: 46,
    },
    {
      chain: 'bsc' as const,
      tokenAddress: '0x1',
      source: 'hot_searches' as const,
      observedAt: 4,
      visitingCount: 46,
    },
  ];
  assert.deepEqual(evaluateCandidateAttention(evidence, attentionConfig), {
    status: 'pass',
    reasons: [],
  });
  assert.deepEqual(evaluateCandidateAttention([], attentionConfig), {
    status: 'incomplete',
    reasons: ['missing:attention'],
  });
});

test('Level 1 and G2 selection deduplicate pools and prioritize active candidates', () => {
  const database = openDatabase(':memory:');
  database
    .prepare(
      `INSERT INTO rule_config_versions (config_hash, git_commit, run_mode, yaml_snapshot, created_at)
       VALUES ('hash', 'commit', 'shadow', 'yaml', 1)`,
    )
    .run();
  const insert = database.prepare(
    `INSERT INTO candidates
     (chain, token_address, cycle_started_at, first_seen_at, last_seen_at, status,
      pool_address, safety_status, safety_json, funnel_status, config_version_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pass', '{}', ?, 1, ?)`,
  );
  insert.run('sol', 'sol-new', 1, 1, 1, 'scouting', 'pool-new', 'level1_checked', 900);
  insert.run('bsc', 'bsc-armed', 2, 2, 2, 'armed', 'pool-bsc', 'armed', 100);
  insert.run('bsc', 'bsc-armed', 3, 3, 3, 'armed', 'pool-bsc', 'armed', 200);
  insert.run('sol', 'sol-armed', 4, 4, 4, 'armed', 'pool-sol', 'armed', 50);

  const level1 = selectLevel1CandidateRows(database, 2);
  assert.deepEqual(
    level1.map((row) => `${row.chain}:${row.pool_address}`),
    ['bsc:pool-bsc', 'sol:pool-sol', 'sol:pool-new'],
  );
  assert.equal(new Set(level1.map((row) => row.pool_address)).size, level1.length);

  const arm = selectArmCandidateRows(database, 3);
  assert.deepEqual(
    arm.map((row) => `${row.chain}:${row.pool_address}:${row.status}:${row.funnel_status}`),
    ['bsc:pool-bsc:armed:armed', 'sol:pool-sol:armed:armed', 'sol:pool-new:scouting:level1_checked'],
  );
  database.close();
});

test('persisted stale cycles expire without terminating anchor lifecycle rows', () => {
  const database = openDatabase(':memory:');
  database
    .prepare(
      `INSERT INTO rule_config_versions (config_hash, git_commit, run_mode, yaml_snapshot, created_at)
       VALUES ('hash', 'commit', 'shadow', 'yaml', 1)`,
    )
    .run();
  const insert = database.prepare(
    `INSERT INTO candidates
     (chain, token_address, cycle_started_at, first_seen_at, last_seen_at, status,
      pool_address, safety_status, safety_json, funnel_status, config_version_id, updated_at)
     VALUES ('bsc', ?, ?, ?, ?, ?, ?, 'pass', '{}', ?, 1, ?)`,
  );
  insert.run('stale-armed', 1, 1, 1_000, 'armed', 'pool-stale', 'armed', 1_000);
  insert.run(
    'pending-anchor',
    2,
    2,
    1_000,
    'confirmed-pending-anchor',
    'pool-anchor',
    'confirmed-pending-anchor',
    1_000,
  );
  insert.run('fresh', 3, 3, 19_500, 'scouting', 'pool-fresh', 'level1_checked', 19_500);

  const expired = expireStaleCandidateRows(
    database,
    'bsc',
    20_000,
    10,
    { maxRows: 20, maxMs: 100 },
  );
  assert.deepEqual(expired, [
    { chain: 'bsc', tokenAddress: 'stale-armed', poolAddress: 'pool-stale' },
  ]);
  assert.deepEqual(
    database
      .prepare('SELECT token_address, status, funnel_status FROM candidates ORDER BY id')
      .all(),
    [
      { token_address: 'stale-armed', status: 'expired', funnel_status: 'armed' },
      {
        token_address: 'pending-anchor',
        status: 'confirmed-pending-anchor',
        funnel_status: 'confirmed-pending-anchor',
      },
      { token_address: 'fresh', status: 'scouting', funnel_status: 'level1_checked' },
    ],
  );
  database.close();
});

function safetyAt(
  status: SafetyResult['status'],
  checkedAt: number,
  expiresAt: number,
): SafetyResult {
  return {
    status,
    reasons: status === 'pass' ? [] : ['fatal:test'],
    checkedAt,
    expiresAt,
    providerEventId: '1',
    configVersionId: '1',
    canonical: {},
  };
}

test('pool resolution selects only fresh current cycles per chain', () => {
  const database = openDatabase(':memory:');
  database
    .prepare(
      `INSERT INTO rule_config_versions (config_hash, git_commit, run_mode, yaml_snapshot, created_at)
       VALUES ('hash', 'commit', 'shadow', 'yaml', 1)`,
    )
    .run();
  const insert = database.prepare(
    `INSERT INTO candidates
     (chain, token_address, cycle_started_at, first_seen_at, last_seen_at, status,
      safety_status, safety_json, funnel_status, config_version_id, updated_at, pool_retry_at)
     VALUES (?, ?, ?, ?, ?, 'scouting', 'pass', '{}', 'safety_checked', 1, ?, ?)`,
  );
  insert.run('bsc', 'same-token', 1, 1, 1_000, 1_000, null);
  insert.run('bsc', 'same-token', 2, 2, 19_000, 19_000, null);
  insert.run('bsc', 'retry-later', 3, 3, 19_000, 19_000, 21_000);
  insert.run('sol', 'other-chain', 4, 4, 19_000, 19_000, null);

  assert.deepEqual(
    selectPoolResolutionRows(database, 'bsc', 20_000, 10, 50).map((row) => row.id),
    [2],
  );
  assert.deepEqual(
    selectPoolResolutionRows(database, 'sol', 20_000, 10, 50).map((row) => row.id),
    [4],
  );
  database.close();
});
