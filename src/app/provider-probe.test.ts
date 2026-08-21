import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canArmG2Candidate,
  evaluateCandidateAttention,
  g2ProbeState,
  latestLevel1ObservedAt,
  selectArmCandidateRows,
  selectLevel1CandidateRows,
  shouldRearmG2Candidate,
} from './provider-probe.js';
import { openDatabase } from '../persistence/db.js';

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
    ['bsc:pool-bsc', 'sol:pool-sol'],
  );
  assert.equal(new Set(level1.map((row) => row.pool_address)).size, level1.length);

  const arm = selectArmCandidateRows(database, 3);
  assert.deepEqual(
    arm.map((row) => `${row.chain}:${row.pool_address}:${row.status}:${row.funnel_status}`),
    ['bsc:pool-bsc:armed:armed', 'sol:pool-sol:armed:armed', 'sol:pool-new:scouting:level1_checked'],
  );
  database.close();
});
