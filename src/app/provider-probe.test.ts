import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  armedSubscriptionsToRelease,
  buildSchedulerDecisionPayload,
  candidateRediscoveryState,
  canArmG2Candidate,
  createCandidatePoolBatches,
  evaluateCandidateAttention,
  expireStaleCandidateRows,
  g2ProbeState,
  g2ArmedLeaseState,
  g2OccupiedIdentities,
  groupLevel1RowsByWorkKind,
  latestLevel1ObservedAt,
  level1ProbeState,
  level1FunnelAfterBatch,
  unchangedLevel1WaitDedupeKey,
  level1WorkDueAt,
  nextLevel1ProbeState,
  outcomeEvaluationPollRequired,
  outcomeEntryCoverageIsComplete,
  planExistingG2Capacity,
  candidateRediscoveryUpdatedAt,
  readOutcomeEntryCoverage,
  readPersistedOutcomePool,
  readRuleConfigVersion,
  recordOutcomeEntryCoverage,
  readLevel1Backlog,
  retainG2SubscriptionDuringCreditPressure,
  isConfirmationWindowUsable,
  refreshConfirmationEvidence,
  selectArmCandidateRows,
  selectLevel1CandidateRows,
  selectPoolResolutionRows,
  shouldRefreshConfirmationEvidence,
  sameChainAddress,
  shouldRearmG2Candidate,
  summarizeLevel1BatchResults,
} from './provider-probe.js';
import { openDatabase } from '../persistence/db.js';
import { insertProviderEvent } from '../persistence/provider-events.js';
import type { SafetyResult } from '../domain/safety.js';
import type { Level1Snapshot } from '../market-data/level1.js';
import { normalizeConfig, parseConfigText } from '../config/load.js';

const botConfig = parseConfigText(
  readFileSync(new URL('../../config/bot.yaml', import.meta.url), 'utf8'),
).config;

test('security refresh address matching is chain-specific', () => {
  assert.equal(sameChainAddress('bsc', '0xABC', '0xabc'), true);
  assert.equal(sameChainAddress('sol', 'AbC', 'abc'), false);
  assert.equal(sameChainAddress('sol', 'AbC', 'AbC'), true);
});

test('Outcome reads immutable settings from the Signal config version snapshot', () => {
  const database = openDatabase(':memory:');
  const saved = structuredClone(botConfig);
  saved.outcomes.outcome_max_lateness_seconds = 30;
  const result = database
    .prepare(
      `INSERT INTO rule_config_versions
       (config_hash, git_commit, run_mode, yaml_snapshot, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run('saved-hash', 'saved-commit', 'shadow', normalizeConfig(saved), 1_000);
  const restored = readRuleConfigVersion(database, Number(result.lastInsertRowid));
  assert.equal(restored?.outcomes.outcome_max_lateness_seconds, 30);
  assert.equal(restored?.delivery.outcome_anchor_destination, 'admin_private');
  database.close();
});

test('Outcome restores its immutable pool identity after the candidate leaves runtime caches', () => {
  const database = openDatabase(':memory:');
  const poolAddress = '0x1234567890abcdef1234567890abcdef12345678';
  const tokenAddress = '0xabcdef0123456789012345678901234567890123';
  const quoteAddress = '0x0000000000000000000000000000000000000001';
  insertProviderEvent(
    database,
    {
      provider: 'coingecko',
      capability: 'pools.multi.level1',
      chain: 'bsc',
      observedAt: 2_000,
      schemaVersion: 'coingecko.pools.multi.v1',
      payload: JSON.stringify({
        data: [
          {
            id: `bsc_${poolAddress}`,
            type: 'pool',
            attributes: {
              address: poolAddress,
              reserve_in_usd: '10000',
              volume_usd: { h24: '5000' },
              pool_created_at: '1970-01-01T00:00:01.000Z',
              transactions: { h24: { buys: 5, sells: 4 } },
            },
            relationships: {
              base_token: { data: { id: `bsc_${tokenAddress}` } },
              quote_token: { data: { id: `bsc_${quoteAddress}` } },
            },
          },
        ],
      }),
    },
    { maxRows: 10, maxMs: 1_000 },
  );

  const restored = readPersistedOutcomePool(
    database,
    'bsc',
    tokenAddress,
    `0x${poolAddress.slice(2).toUpperCase()}`,
    1_000,
    2_500,
  );
  assert.equal(restored?.identityKey, `bsc:${poolAddress}:${tokenAddress}`);
  assert.equal(restored?.targetSide, 'base');
  assert.equal(restored && readOutcomeEntryCoverage(database, 7, restored), undefined);
  if (restored) {
    insertProviderEvent(
      database,
      {
        provider: 'runtime',
        capability: 'outcome.entry.coverage',
        chain: restored.chain,
        tokenAddress: restored.tokenAddress,
        poolAddress: restored.poolAddress,
        observedAt: 2_900,
        schemaVersion: 'runtime.outcome.entry.coverage.v1',
        payload: JSON.stringify({ signalId: 7, complete: true, observedAt: 2_900 }),
      },
      { maxRows: 10, maxMs: 1_000 },
    );
    assert.equal(readOutcomeEntryCoverage(database, 7, restored), undefined);
    recordOutcomeEntryCoverage(database, { maxRows: 10, maxMs: 1_000 }, 7, restored, true, 3_000);
    assert.equal(readOutcomeEntryCoverage(database, 7, restored), true);
    assert.equal(readOutcomeEntryCoverage(database, 8, restored), undefined);
  }
  assert.equal(readPersistedOutcomePool(database, 'sol', tokenAddress, poolAddress), undefined);
  database.close();
});

test('Outcome entry coverage fails closed across disconnects, restarts, and queue pressure', () => {
  assert.equal(outcomeEntryCoverageIsComplete(3, 3, true, true, false), true);
  assert.equal(outcomeEntryCoverageIsComplete(3, 4, true, true, false), false);
  assert.equal(outcomeEntryCoverageIsComplete(-1, 3, true, true, false), false);
  assert.equal(outcomeEntryCoverageIsComplete(undefined, 3, true, true, false), false);
  assert.equal(outcomeEntryCoverageIsComplete(3, 3, false, true, false), false);
  assert.equal(outcomeEntryCoverageIsComplete(3, 3, true, false, false), false);
  assert.equal(outcomeEntryCoverageIsComplete(3, 3, true, true, true), false);
});

test('Outcome forces a poll after the fixed horizon candle closes and before cutoff', () => {
  const input = {
    anchorDeliveredAt: 1_385,
    horizonsSeconds: [60],
    maxLatenessSeconds: 60,
    candleIntervalSeconds: 30,
  };
  assert.equal(outcomeEvaluationPollRequired({ ...input, now: 89_999, candles: [] }), false);
  assert.equal(outcomeEvaluationPollRequired({ ...input, now: 90_000, candles: [] }), true);
  assert.equal(
    outcomeEvaluationPollRequired({
      ...input,
      now: 100_000,
      candles: [{ openTime: 60_000, observedAt: 99_000, isClosed: true }],
    }),
    false,
  );
  assert.equal(
    outcomeEvaluationPollRequired({
      ...input,
      now: 100_000,
      candles: [{ openTime: 60_000, observedAt: 122_000, isClosed: true }],
    }),
    true,
  );
  assert.equal(outcomeEvaluationPollRequired({ ...input, now: 121_386, candles: [] }), false);
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

test('Level 1 provider health follows supplier batches, not candidate-local gaps', () => {
  assert.equal(level1ProbeState(0, 0), 'unknown');
  assert.equal(level1ProbeState(2, 0), 'ok');
  assert.equal(level1ProbeState(2, 1), 'ok');
  assert.equal(level1ProbeState(2, 2), 'failed');
  assert.throws(() => level1ProbeState(1, 2), /Invalid Level 1 batch counts/);
  assert.equal(nextLevel1ProbeState('ok', 0, 0), 'ok');
  assert.equal(nextLevel1ProbeState('unknown', 0, 0), 'unknown');
  assert.equal(nextLevel1ProbeState('ok', 1, 0), 'ok');
  assert.equal(nextLevel1ProbeState('ok', 1, 1), 'failed');
});

test('failed Level 1 batches remain visible in attempted and failure health counts', () => {
  const summary = summarizeLevel1BatchResults(
    [50, 20],
    [
      { status: 'fulfilled', value: { attempted: 50, complete: 48 } },
      { status: 'rejected', reason: new Error('scheduler:credit_deferred') },
    ],
  );
  assert.deepEqual(summary, { attempted: 70, complete: 48, failures: 1, deferred: 1 });
  assert.throws(() => summarizeLevel1BatchResults([50], []), /does not match scheduled work/u);
});

test('Level 1 acceptance clocks start when each work kind actually becomes due', () => {
  const row = { chain: 'sol' as const, updated_at: 1_000 };
  const refresh = { recheck: 60, active: { sol: 45, bsc: 30 } };
  assert.equal(level1WorkDueAt(row, 'candidate_batch', refresh), 1_000);
  assert.equal(level1WorkDueAt(row, 'armed_batch', refresh), 46_000);
  assert.equal(level1WorkDueAt(row, 'recheck', refresh), 61_000);
  assert.equal(
    level1WorkDueAt({ chain: 'bsc', updated_at: 2_000 }, 'armed_batch', refresh),
    32_000,
  );
});

test('successful Level 1 batches cadence local gaps without corrupting active lifecycles', () => {
  assert.equal(level1FunnelAfterBatch('scouting', 'pool_resolved', true), 'level1_screened');
  assert.equal(level1FunnelAfterBatch('scouting', 'pool_resolved', false), 'pool_resolved');
  assert.equal(level1FunnelAfterBatch('armed', 'armed', true), 'armed');
  assert.equal(
    level1FunnelAfterBatch('confirmed-pending-anchor', 'confirmed-pending-anchor', true),
    'confirmed-pending-anchor',
  );
  assert.equal(level1FunnelAfterBatch('delivered', 'delivered', true), 'delivered');
});

test('unchanged scheduler waits deduplicate until a batch can run again', () => {
  assert.equal(
    unchangedLevel1WaitDedupeKey('scheduler:credit_deferred', 'candidate_batch', 'sol:a,b'),
    'level1-wait:candidate_batch:sol:a,b',
  );
  assert.equal(
    unchangedLevel1WaitDedupeKey('scheduler:backlog_high_watermark', 'recheck', 'bsc:0x1'),
    'level1-wait:recheck:bsc:0x1',
  );
  assert.equal(
    unchangedLevel1WaitDedupeKey('provider timeout', 'candidate_batch', 'sol:a,b'),
    undefined,
  );
});

test('scheduler batch evidence preserves cohort clock and per-candidate screening result', () => {
  const payload = JSON.parse(
    buildSchedulerDecisionPayload(
      {
        decision: 'complete',
        reason: 'supplier_response_persisted_and_screened',
        priority: 'candidate_batch',
        chain: 'sol',
        candidates: [
          {
            tokenAddress: 'token',
            poolAddress: 'pool',
            cycleStartedAt: 900,
            dueAt: 1_000,
            screeningStatus: 'complete',
          },
        ],
      },
      1_250,
      44,
    ),
  ) as Record<string, unknown>;
  assert.equal(payload.eventTime, 1_250);
  assert.equal(payload.evidenceCutoffAt, 1_250);
  assert.equal(payload.configVersionId, '44');
  assert.deepEqual(payload.candidates, [
    {
      tokenAddress: 'token',
      poolAddress: 'pool',
      cycleStartedAt: 900,
      dueAt: 1_000,
      screeningStatus: 'complete',
    },
  ]);
});

test('confirmation refresh only runs for refreshable evidence gaps', () => {
  assert.equal(shouldRefreshConfirmationEvidence(['level1:stale', 'conviction:incomplete']), true);
  assert.equal(
    shouldRefreshConfirmationEvidence([
      'safety:not_fresh_or_config_mismatch',
      'entryQuality:rejected',
    ]),
    false,
  );
  assert.equal(shouldRefreshConfirmationEvidence(['level1:stale', 'attention:rejected']), false);
  assert.equal(shouldRefreshConfirmationEvidence(['level1:stale', 'entryQuality:rejected']), false);
  assert.equal(shouldRefreshConfirmationEvidence(['level1:stale', 'age:rejected:no_data']), false);
  assert.equal(
    shouldRefreshConfirmationEvidence(['level1:stale', 'g2:zero', 'evidence:incomplete']),
    false,
  );
  assert.equal(shouldRefreshConfirmationEvidence(['entry_quality:missing_price_baseline']), false);
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
  assert.equal(
    shouldRearmG2Candidate('confirmed-pending-anchor', 'confirmed-pending-anchor'),
    true,
  );
  assert.equal(shouldRearmG2Candidate('delivered', 'delivered'), false);
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
  assert.deepEqual(armedSubscriptionsToRelease(active, new Set(['bsc:keep:token'])), [
    'bsc:old:token',
  ]);
  assert.deepEqual([...g2OccupiedIdentities(active, new Set(['bsc:keep:token']))].sort(), [
    'bsc:keep:token',
    'sol:anchor:token',
  ]);
});

test('ordinary Armed subscriptions rotate after the configured lease but anchors do not', () => {
  assert.equal(g2ArmedLeaseState('armed', undefined, 120_000, 120), 'start');
  assert.equal(g2ArmedLeaseState('armed', 1_000, 120_999, 120), 'active');
  assert.equal(g2ArmedLeaseState('armed', 1_000, 121_000, 120), 'elapsed');
  assert.equal(g2ArmedLeaseState('confirmed-pending-anchor', 1_000, 999_000, 120), 'not_armed');
});

test('production credit pressure releases ordinary G2 but preserves Outcome anchors', () => {
  assert.equal(retainG2SubscriptionDuringCreditPressure('shadow', true, 'armed'), true);
  assert.equal(retainG2SubscriptionDuringCreditPressure('production', false, 'armed'), true);
  assert.equal(retainG2SubscriptionDuringCreditPressure('production', true, 'armed'), false);
  assert.equal(
    retainG2SubscriptionDuringCreditPressure('production', true, 'confirmed-pending-anchor'),
    true,
  );
});

test('candidate rediscovery keeps anchor history immutable and requeues old-config Armed state', () => {
  assert.deepEqual(
    candidateRediscoveryState({
      status: 'armed',
      funnelStatus: 'armed',
      previousConfigVersionId: 49,
      currentConfigVersionId: 52,
    }),
    { preserveHistorical: false, status: 'scouting', funnelStatus: 'safety_checked' },
  );
  assert.deepEqual(
    candidateRediscoveryState({
      status: 'armed',
      funnelStatus: 'armed',
      previousConfigVersionId: 52,
      currentConfigVersionId: 52,
    }),
    { preserveHistorical: false, status: 'armed', funnelStatus: 'armed' },
  );
  for (const status of ['confirmed-pending-anchor', 'delivered', 'completed'])
    assert.deepEqual(
      candidateRediscoveryState({
        status,
        funnelStatus: status,
        previousConfigVersionId: 49,
        currentConfigVersionId: 52,
      }),
      { preserveHistorical: true, status, funnelStatus: status },
    );
  assert.deepEqual(
    candidateRediscoveryState({
      status: 'scouting',
      funnelStatus: 'safety_checked',
      previousConfigVersionId: 52,
      currentConfigVersionId: 52,
    }),
    { preserveHistorical: false, status: 'scouting', funnelStatus: 'safety_checked' },
  );
  assert.equal(candidateRediscoveryUpdatedAt(1_000, 2_000, 'armed'), 1_000);
  assert.equal(candidateRediscoveryUpdatedAt(1_000, 2_000, 'scouting'), 2_000);
});

test('G2 capacity shrink preserves pending anchors and requeues Armed candidates', () => {
  const rows = [
    { row: { status: 'confirmed-pending-anchor', chain: 'sol' as const }, id: 'anchor' },
    { row: { status: 'armed', chain: 'sol' as const }, id: 'sol-a' },
    { row: { status: 'armed', chain: 'sol' as const }, id: 'sol-b' },
    { row: { status: 'armed', chain: 'bsc' as const }, id: 'bsc-a' },
  ];
  const plan = planExistingG2Capacity(rows, 4);
  assert.equal(plan.overflowed, true);
  assert.deepEqual(
    plan.retained.map((row) => row.id),
    ['anchor', 'sol-a', 'bsc-a'],
  );
  assert.deepEqual(
    plan.demoted.map((row) => row.id),
    ['sol-b'],
  );
  assert.equal(planExistingG2Capacity(rows.slice(0, 2), 4).overflowed, false);
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

test('pool request deduplication preserves both token identities sharing one pool', () => {
  const rows = [
    { chain: 'bsc' as const, token_address: '0xbase', pool_address: '0xPOOL' },
    { chain: 'bsc' as const, token_address: '0xquote', pool_address: '0xpool' },
    { chain: 'sol' as const, token_address: 'sol-token', pool_address: '0xpool' },
  ];
  const batches = createCandidatePoolBatches(rows, 'bsc', 50);
  assert.equal(batches.length, 1);
  assert.deepEqual(
    batches[0]!.map((row) => row.token_address),
    ['0xbase', '0xquote'],
  );
});

test('Level 1 batches isolate priorities while a shared pool inherits Armed service', () => {
  const rows = [
    {
      chain: 'bsc' as const,
      token_address: 'armed-token',
      pool_address: '0xPOOL',
      status: 'armed',
      funnel_status: 'armed',
    },
    {
      chain: 'bsc' as const,
      token_address: 'new-same-pool',
      pool_address: '0xpool',
      status: 'scouting',
      funnel_status: 'pool_resolved',
    },
    {
      chain: 'bsc' as const,
      token_address: 'new-token',
      pool_address: '0xnew',
      status: 'scouting',
      funnel_status: 'pool_resolved',
    },
    {
      chain: 'bsc' as const,
      token_address: 'recheck-token',
      pool_address: '0xrecheck',
      status: 'scouting',
      funnel_status: 'level1_screened',
    },
  ];
  const groups = groupLevel1RowsByWorkKind(rows, 'bsc');
  assert.deepEqual(
    groups.armed_batch.map((row) => row.token_address),
    ['armed-token', 'new-same-pool'],
  );
  assert.deepEqual(
    groups.candidate_batch.map((row) => row.token_address),
    ['new-token'],
  );
  assert.deepEqual(
    groups.recheck.map((row) => row.token_address),
    ['recheck-token'],
  );
});

test('Level 1 and G2 selection deduplicate pools and prioritize active candidates', () => {
  const database = openDatabase(':memory:');
  database
    .prepare(
      `INSERT INTO rule_config_versions (config_hash, git_commit, run_mode, yaml_snapshot, created_at)
       VALUES ('hash', 'commit', 'shadow', 'yaml', 1)`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO rule_config_versions (config_hash, git_commit, run_mode, yaml_snapshot, created_at)
       VALUES ('hash-2', 'commit', 'shadow', 'yaml', 2)`,
    )
    .run();
  const insert = database.prepare(
    `INSERT INTO candidates
     (chain, token_address, cycle_started_at, first_seen_at, last_seen_at, status,
      pool_address, safety_status, safety_json, funnel_status, config_version_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pass', '{"expiresAt":999999}', ?, 1, ?)`,
  );
  insert.run('sol', 'sol-new', 1, 1, 1, 'scouting', 'pool-new', 'level1_checked', 900);
  insert.run('bsc', 'bsc-armed', 2, 2, 2, 'armed', 'pool-bsc', 'armed', 100);
  insert.run('bsc', 'bsc-armed', 3, 3, 3, 'armed', 'pool-bsc', 'armed', 200);
  insert.run('sol', 'sol-armed', 4, 4, 4, 'armed', 'pool-sol', 'armed', 50);
  database
    .prepare(
      `INSERT INTO candidates
       (chain, token_address, cycle_started_at, first_seen_at, last_seen_at, status,
        pool_address, safety_status, safety_json, funnel_status, config_version_id, updated_at)
       VALUES ('sol', 'old-config', 5, 5, 999, 'scouting', 'pool-old', 'pass', '{"expiresAt":999999}',
               'level1_checked', 2, 5)`,
    )
    .run();
  insert.run('sol', 'stale-normal', 6, 6, -20_000, 'scouting', 'pool-stale', 'level1_checked', 6);
  database
    .prepare(
      `INSERT INTO candidates
       (chain, token_address, cycle_started_at, first_seen_at, last_seen_at, status,
        pool_address, safety_status, safety_json, funnel_status, config_version_id, updated_at)
       VALUES ('sol', 'stale-safety', 7, 7, 999, 'scouting', 'pool-unsafe', 'pass',
               '{"expiresAt":500}', 'level1_checked', 1, 7)`,
    )
    .run();

  const level1 = selectLevel1CandidateRows(
    database,
    2,
    1,
    2_000,
    { sol: 10, bsc: 10 },
    { recheck: 1, active: { sol: 1, bsc: 1 } },
  );
  assert.deepEqual(
    level1.map((row) => `${row.chain}:${row.pool_address}`),
    ['bsc:pool-bsc', 'sol:pool-sol', 'sol:pool-new'],
  );
  assert.equal(new Set(level1.map((row) => row.pool_address)).size, level1.length);

  const arm = selectArmCandidateRows(database, 3, 1, 1_000, { sol: 10, bsc: 10 });
  assert.deepEqual(
    arm.map((row) => `${row.chain}:${row.pool_address}:${row.status}:${row.funnel_status}`),
    [
      'bsc:pool-bsc:armed:armed',
      'sol:pool-sol:armed:armed',
      'sol:pool-new:scouting:level1_checked',
    ],
  );
  database.close();
});

test('bounded Level 1 window rotates processed candidates instead of starving SQLite overflow', () => {
  const database = openDatabase(':memory:');
  database
    .prepare(
      `INSERT INTO rule_config_versions (config_hash, git_commit, run_mode, yaml_snapshot, created_at)
       VALUES ('rotation', 'commit', 'shadow', 'yaml', 1)`,
    )
    .run();
  const insert = database.prepare(
    `INSERT INTO candidates
     (chain, token_address, cycle_started_at, first_seen_at, last_seen_at, status,
      pool_address, safety_status, safety_json, funnel_status, config_version_id, updated_at)
     VALUES ('sol', ?, ?, ?, 900, 'scouting', ?, 'pass', '{"expiresAt":999999}', 'level1_screened', 1, ?)`,
  );
  insert.run('token-1', 1, 1, 'pool-1', 1);
  insert.run('token-2', 2, 2, 'pool-2', 2);
  insert.run('token-3', 3, 3, 'pool-3', 3);
  const first = selectLevel1CandidateRows(
    database,
    1,
    1,
    2_000,
    { sol: 10, bsc: 10 },
    { recheck: 1, active: { sol: 1, bsc: 1 } },
  );
  assert.equal(first[0]?.token_address, 'token-1');
  database.prepare('UPDATE candidates SET updated_at = 2000 WHERE id = ?').run(first[0]!.id);
  const second = selectLevel1CandidateRows(
    database,
    1,
    1,
    2_000,
    { sol: 10, bsc: 10 },
    { recheck: 1, active: { sol: 1, bsc: 1 } },
  );
  assert.equal(second[0]?.token_address, 'token-2');
  database.close();
});

test('Level 1 polls new pools immediately but waits for configured recheck cadences', () => {
  const database = openDatabase(':memory:');
  database
    .prepare(
      `INSERT INTO rule_config_versions (config_hash, git_commit, run_mode, yaml_snapshot, created_at)
       VALUES ('cadence', 'commit', 'shadow', 'yaml', 1)`,
    )
    .run();
  const insert = database.prepare(
    `INSERT INTO candidates
     (chain, token_address, cycle_started_at, first_seen_at, last_seen_at, status,
      pool_address, safety_status, safety_json, funnel_status, config_version_id, updated_at)
     VALUES ('sol', ?, ?, 1, 100000, ?, ?, 'pass', '{"expiresAt":999999}', ?, 1, ?)`,
  );
  insert.run('new', 1, 'scouting', 'pool-new', 'pool_resolved', 99_999);
  insert.run('recent-recheck', 2, 'scouting', 'pool-recheck', 'level1_screened', 99_999);
  insert.run('recent-armed', 3, 'armed', 'pool-armed', 'armed', 99_999);
  insert.run('due-recheck', 4, 'scouting', 'pool-due', 'level1_screened', 50_000);
  insert.run('delivered', 5, 'delivered', 'pool-delivered', 'delivered', 1);
  const rows = selectLevel1CandidateRows(
    database,
    10,
    1,
    100_000,
    { sol: 600, bsc: 600 },
    { recheck: 45, active: { sol: 45, bsc: 45 } },
  );
  assert.deepEqual(
    rows.map((row) => row.token_address),
    ['new', 'due-recheck'],
  );
  assert.deepEqual(
    readLevel1Backlog(
      database,
      1,
      100_000,
      { sol: 600, bsc: 600 },
      { recheck: 45, active: { sol: 45, bsc: 45 } },
    ),
    { count: 2, oldestAt: 50_000 + 45_000 },
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
     VALUES ('bsc', ?, ?, ?, ?, ?, ?, 'pass', '{"expiresAt":999999}', ?, 1, ?)`,
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

  const expired = expireStaleCandidateRows(database, 'bsc', 20_000, 10, {
    maxRows: 20,
    maxMs: 100,
  });
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
     VALUES (?, ?, ?, ?, ?, 'scouting', 'pass', '{"expiresAt":999999}', 'safety_checked', 1, ?, ?)`,
  );
  insert.run('bsc', 'same-token', 1, 1, 1_000, 1_000, null);
  insert.run('bsc', 'same-token', 2, 2, 19_000, 19_000, null);
  insert.run('bsc', 'retry-later', 3, 3, 19_000, 19_000, 21_000);
  insert.run('sol', 'other-chain', 4, 4, 19_000, 19_000, null);

  assert.deepEqual(
    selectPoolResolutionRows(database, 'bsc', 20_000, 10, 50, 1).map((row) => row.id),
    [2],
  );
  assert.deepEqual(
    selectPoolResolutionRows(database, 'sol', 20_000, 10, 50, 1).map((row) => row.id),
    [4],
  );
  database.close();
});
