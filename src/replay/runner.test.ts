import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../persistence/db.js';
import { cleanupReplayTemporary, createReplayBackup } from './backup.js';
import { loadReplayConfig } from './config.js';
import { runReplay } from './runner.js';
import { buildSimulatedCandidates, evidenceVisibleAt, rebuildCandidateCycles } from './timeline.js';
import type { DiscoveryObservation } from '../pipeline/candidate.js';

const configText = readFileSync('config/bot.yaml', 'utf8');
const discovery: DiscoveryObservation[] = [
  {
    chain: 'sol',
    tokenAddress: 'So11111111111111111111111111111111111111112',
    source: 'trending_1m',
    observedAt: 1_000,
    rank: 10,
  },
  {
    chain: 'sol',
    tokenAddress: 'So11111111111111111111111111111111111111112',
    source: 'trending_1m',
    observedAt: 2_000,
    rank: 9,
  },
  {
    chain: 'sol',
    tokenAddress: 'So11111111111111111111111111111111111111112',
    source: 'trending_1m',
    observedAt: 20_000,
    rank: 8,
  },
];

test('replay config accepts one clean source and explicit saved overrides only', () => {
  const current = loadReplayConfig({ currentBotYaml: configText, worktreeStatus: '' });
  assert.equal(current.config.replay.delivery_delay_ms, 5_000);
  const saved = loadReplayConfig({
    savedConfigYaml: configText,
    overrides: ['replay.delivery_delay_ms=2500'],
    worktreeStatus: '',
  });
  assert.equal(saved.config.replay.delivery_delay_ms, 2_500);
  assert.throws(
    () =>
      loadReplayConfig({
        currentBotYaml: configText,
        savedConfigYaml: configText,
        worktreeStatus: '',
      }),
    /one config source/,
  );
  assert.throws(
    () => loadReplayConfig({ currentBotYaml: configText, worktreeStatus: ' M config/bot.yaml' }),
    /clean worktree/,
  );
});

test('candidate replay recomputes cycle boundaries from TTL and never uses future evidence', () => {
  const short = rebuildCandidateCycles(discovery, 5, 20_000);
  const long = rebuildCandidateCycles(discovery, 30, 20_000);
  assert.equal(short.length, 2);
  assert.equal(long.length, 1);
  const evidence = [
    {
      kind: 'g2' as const,
      observedAt: 2_500,
      tokenAddress: discovery[0]!.tokenAddress,
      payload: {},
    },
    {
      kind: 'safety' as const,
      observedAt: 4_000,
      tokenAddress: discovery[0]!.tokenAddress,
      payload: {},
    },
  ];
  assert.deepEqual(
    evidenceVisibleAt(evidence, 3_000, 5_000).map((item) => item.kind),
    ['g2'],
  );
  const simulated = buildSimulatedCandidates({
    observations: discovery,
    evidence,
    ttlSeconds: 30,
    dataCutoffAt: 20_000,
    deliveryDelayMs: 500,
  });
  assert.equal(simulated[0]!.deliveryAt, 20_500);
  assert.equal(simulated[0]!.evidenceAtDelivery.length, 2);
});

test('replay writes only replay tables and marks missing G2 unavailable', () => {
  const database = openDatabase(':memory:');
  database
    .prepare(
      `INSERT INTO rule_config_versions (config_hash, git_commit, run_mode, yaml_snapshot, created_at)
     VALUES ('hash', 'commit', 'shadow', 'yaml', 1)`,
    )
    .run();
  const result = runReplay({
    database,
    configVersionId: 1,
    gitCommit: 'commit',
    runMode: 'shadow',
    dataCutoffAt: 30_000,
    now: 31_000,
    startedAt: 30_000,
    deliveryDelayMs: 500,
    candidateTtlSeconds: 30,
    outcomeMaxLatenessSeconds: 5,
    horizonSeconds: [60],
    discovery,
    evidence: [
      { kind: 'safety', observedAt: 20_100, tokenAddress: discovery[0]!.tokenAddress, payload: {} },
    ],
    resultBatchSize: 1,
    worktreeStatus: '',
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.unavailableCount, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM replay_results').pluck().get(), 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM delivery_outbox').pluck().get(), 0);
  database.close();
});

test('replay pauses for live backlog and records failed runs for recovery', () => {
  const database = openDatabase(':memory:');
  database
    .prepare(
      `INSERT INTO rule_config_versions (config_hash, git_commit, run_mode, yaml_snapshot, created_at)
     VALUES ('hash', 'commit', 'shadow', 'yaml', 1)`,
    )
    .run();
  const base = {
    database,
    configVersionId: 1,
    gitCommit: 'commit',
    runMode: 'shadow' as const,
    dataCutoffAt: 30_000,
    now: 31_000,
    startedAt: 30_000,
    deliveryDelayMs: 0,
    candidateTtlSeconds: 30,
    outcomeMaxLatenessSeconds: 5,
    horizonSeconds: [60],
    discovery,
    evidence: [],
    resultBatchSize: 1,
    worktreeStatus: '',
  };
  const paused = runReplay({ ...base, shouldYield: () => true });
  assert.equal(paused.status, 'paused');
  assert.equal(
    database.prepare('SELECT status FROM replay_runs WHERE id = ?').pluck().get(paused.runId),
    'paused',
  );
  assert.throws(() => runReplay({ ...base, gitCommit: 'other' }), /does not match/);
  assert.throws(
    () =>
      runReplay({
        ...base,
        shouldYield: () => {
          throw new Error('live backlog check failed');
        },
      }),
    /live backlog check failed/,
  );
  assert.equal(
    database.prepare("SELECT status FROM replay_runs WHERE status = 'failed'").pluck().get(),
    'failed',
  );
  database.close();
});

test('replay creates a consistent SQLite backup with bounded page progress', async () => {
  const database = openDatabase(':memory:');
  const directory = mkdtempSync(path.join('/tmp', 'replay-backup-'));
  const destination = path.join(directory, 'snapshot.sqlite');
  const progress: number[] = [];
  const backup = await createReplayBackup(database, {
    destination,
    runId: 7,
    pageBatch: 2,
    minimumFreeBytes: 1,
    onProgress: (remaining) => progress.push(remaining),
  });
  assert.equal(backup.destination, destination);
  assert.ok(progress.length > 0);
  cleanupReplayTemporary(directory, 7);
  rmSync(directory, { recursive: true, force: true });
  database.close();
});
