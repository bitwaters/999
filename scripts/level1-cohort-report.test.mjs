import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

test('cohort report reconstructs batch and reservation clocks from persisted evidence', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'level1-cohort-report-'));
  const databasePath = path.join(directory, 'fixture.sqlite');
  try {
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE rule_config_versions (
        id INTEGER PRIMARY KEY, config_hash TEXT, git_commit TEXT, run_mode TEXT,
        yaml_snapshot TEXT, created_at INTEGER
      );
      CREATE TABLE provider_events (
        id INTEGER PRIMARY KEY, provider TEXT, capability TEXT, chain TEXT,
        token_address TEXT, pool_address TEXT, observed_at INTEGER,
        payload_encoding TEXT, payload BLOB
      );
      CREATE TABLE candidates (
        id INTEGER PRIMARY KEY, chain TEXT, config_version_id INTEGER, safety_status TEXT,
        status TEXT, funnel_status TEXT, pool_address TEXT, last_seen_at INTEGER,
        safety_json TEXT, updated_at INTEGER
      );
      CREATE TABLE signals (id INTEGER PRIMARY KEY, candidate_id INTEGER, config_version_id INTEGER);
      CREATE TABLE outcomes (id INTEGER PRIMARY KEY, signal_id INTEGER, config_version_id INTEGER);
    `);
    database
      .prepare(
        `INSERT INTO rule_config_versions VALUES
         (1, 'hash', 'commit', 'shadow',
          'providers:\n  coingecko:\n    scheduler:\n      dynamic_recheck_seconds: 60\nchains:\n  sol:\n    discovery:\n      candidate_ttl_seconds: 900\n    level1:\n      refresh_interval_seconds: 45\n  bsc:\n    discovery:\n      candidate_ttl_seconds: 900\n    level1:\n      refresh_interval_seconds: 45',
          1000)`,
      )
      .run();
    const insertEvent = database.prepare(
      `INSERT INTO provider_events
       (provider, capability, chain, token_address, pool_address, observed_at,
        payload_encoding, payload) VALUES (?, ?, ?, ?, ?, ?, 'identity', ?)`,
    );
    const candidates = Array.from({ length: 5 }, (_, index) => ({
      tokenAddress: `token-${index}`,
      poolAddress: `pool-${index}`,
      cycleStartedAt: 1_100 + index,
      dueAt: 1_250,
      screeningStatus: 'complete',
    }));
    insertEvent.run(
      'runtime',
      'scheduler.decision',
      'sol',
      null,
      null,
      1_500,
      Buffer.from(
        JSON.stringify({
          decision: 'complete',
          reason: 'supplier_response_persisted_and_screened',
          priority: 'candidate_batch',
          eventTime: 1_500,
          evidenceCutoffAt: 1_500,
          configVersionId: '1',
          candidates,
        }),
      ),
    );
    for (const [decision, at] of [
      ['reservation_acquired', 1_600],
      ['armed', 1_900],
    ])
      insertEvent.run(
        'runtime',
        'scheduler.decision',
        'sol',
        'token-0',
        'pool-0',
        at,
        Buffer.from(
          JSON.stringify({
            decision,
            reason: 'fixture',
            priority: 'candidate_batch',
            eventTime: at,
            evidenceCutoffAt: at,
            configVersionId: '1',
            cycleStartedAt: 1_100,
          }),
        ),
      );
    insertEvent.run('coingecko', 'pools.multi.level1', 'sol', null, null, 1_500, Buffer.from('{}'));
    insertEvent.run(
      'coingecko',
      'trades.level1',
      'sol',
      'token-0',
      'pool-0',
      1_700,
      Buffer.from('{}'),
    );
    for (const used of [100, 104])
      insertEvent.run(
        'coingecko',
        'key',
        null,
        null,
        null,
        1_800 + used,
        Buffer.from(JSON.stringify({ api_key_current_total_monthly_calls: used })),
      );
    const now = Date.now();
    database
      .prepare(
        `INSERT INTO candidates
         (id, chain, config_version_id, safety_status, status, funnel_status, pool_address,
          last_seen_at, safety_json, updated_at)
         VALUES (1, 'sol', 1, 'pass', 'scouting', 'level1_screened', 'pool-0', ?, ?, ?)`,
      )
      .run(now, JSON.stringify({ expiresAt: now + 60_000 }), now - 120_000);
    database.close();

    const result = spawnSync(process.execPath, ['scripts/level1-cohort-report.mjs'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, BOT_DATABASE_PATH: databasePath },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.chains.sol.valid_batch_candidates, 5);
    assert.deepEqual(report.chains.sol.level1_latency, {
      samples: 5,
      p50_ms: 250,
      p95_ms: 250,
      max_ms: 250,
    });
    assert.deepEqual(report.chains.sol.finalist_to_g2_latency, {
      samples: 1,
      p50_ms: 300,
      p95_ms: 300,
      max_ms: 300,
    });
    assert.equal(report.chains.sol.rest_calls.reduction_percent, 66.67);
    assert.equal(report.chains.sol.backlog.due, 1);
    assert.ok(report.chains.sol.backlog.oldest_wait_ms >= 59_000);
    assert.ok(report.chains.sol.backlog.oldest_wait_ms < 65_000);
    assert.equal(report.credits.used_delta, 4);
    assert.equal(report.recommendation, 'hold_shadow');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
