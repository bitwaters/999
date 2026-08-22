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
      CREATE TABLE delivery_outbox (
        id INTEGER PRIMARY KEY, signal_id INTEGER, destination TEXT, message_type TEXT,
        status TEXT, delivery_uncertain INTEGER, sent_at INTEGER
      );
      CREATE TABLE outcomes (
        id INTEGER PRIMARY KEY, signal_id INTEGER, config_version_id INTEGER,
        anchor_destination TEXT, anchor_delivered_at INTEGER, execution_status TEXT,
        delivery_to_entry_latency_ms INTEGER, horizon_results_json TEXT
      );
    `);
    database
      .prepare(
        `INSERT INTO rule_config_versions VALUES
         (1, 'hash', 'commit', 'shadow',
          'providers:\n  coingecko:\n    scheduler:\n      dynamic_recheck_seconds: 60\nchains:\n  sol:\n    discovery:\n      candidate_ttl_seconds: 900\n    level1:\n      refresh_interval_seconds: 45\n  bsc:\n    discovery:\n      candidate_ttl_seconds: 900\n    level1:\n      refresh_interval_seconds: 45\noutcomes:\n  horizons_seconds: [3600]\ndelivery:\n  outcome_anchor_destination: admin_private',
          1000)`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO rule_config_versions VALUES
         (2, 'next-hash', 'next-commit', 'shadow',
          'providers:\n  coingecko:\n    scheduler:\n      dynamic_recheck_seconds: 60\nchains:\n  sol:\n    discovery:\n      candidate_ttl_seconds: 900\n    level1:\n      refresh_interval_seconds: 45\n  bsc:\n    discovery:\n      candidate_ttl_seconds: 900\n    level1:\n      refresh_interval_seconds: 45\noutcomes:\n  horizons_seconds: [3600]\ndelivery:\n  outcome_anchor_destination: admin_private',
          2000)`,
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
    insertEvent.run(
      'runtime',
      'scheduler.decision',
      'sol',
      null,
      null,
      1_200,
      Buffer.from(
        JSON.stringify({
          decision: 'defer',
          reason: 'scheduler:credit_deferred',
          priority: 'candidate_batch',
          eventTime: 1_200,
          evidenceCutoffAt: 1_200,
          configVersionId: '1',
          candidates: [candidates[2]],
        }),
      ),
    );
    insertEvent.run(
      'runtime',
      'scheduler.decision',
      'sol',
      null,
      null,
      1_400,
      Buffer.from(
        JSON.stringify({
          decision: 'defer',
          reason: 'scheduler:credit_deferred',
          priority: 'candidate_batch',
          eventTime: 1_400,
          evidenceCutoffAt: 1_400,
          configVersionId: '1',
          candidates: [candidates[1]],
        }),
      ),
    );
    insertEvent.run(
      'runtime',
      'scheduler.decision',
      'sol',
      null,
      null,
      1_550,
      Buffer.from(
        JSON.stringify({
          decision: 'defer',
          reason: 'scheduler:credit_deferred',
          priority: 'candidate_batch',
          eventTime: 1_550,
          evidenceCutoffAt: 1_550,
          configVersionId: '1',
          candidates: [candidates[0]],
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
    insertEvent.run('coingecko', 'pools.multi.level1', 'sol', null, null, 2_100, Buffer.from('{}'));
    insertEvent.run(
      'coingecko',
      'key',
      null,
      null,
      null,
      2_200,
      Buffer.from(JSON.stringify({ api_key_current_total_monthly_calls: 999 })),
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
    const insertCandidate = database.prepare(
      `INSERT INTO candidates
       (id, chain, config_version_id, safety_status, status, funnel_status, pool_address,
        last_seen_at, safety_json, updated_at)
       VALUES (?, ?, 1, 'fatal', 'completed', 'completed', ?, 0, '{}', 0)`,
    );
    const insertSignal = database.prepare(
      'INSERT INTO signals (id, candidate_id, config_version_id) VALUES (?, ?, 1)',
    );
    const insertOutbox = database.prepare(
      `INSERT INTO delivery_outbox
       (id, signal_id, destination, message_type, status, delivery_uncertain, sent_at)
       VALUES (?, ?, 'admin_private', 'ENTRY_SIGNAL', 'sent', 0, ?)`,
    );
    const insertOutcome = database.prepare(
      `INSERT INTO outcomes
       (id, signal_id, config_version_id, anchor_destination, anchor_delivered_at,
        execution_status, delivery_to_entry_latency_ms, horizon_results_json)
       VALUES (?, ?, 1, 'admin_private', ?, ?, ?, ?)`,
    );
    for (const [chainIndex, chain] of ['sol', 'bsc'].entries()) {
      for (let index = 0; index < 100; index += 1) {
        const id = 1_000 + chainIndex * 1_000 + index;
        const signalId = 3_000 + chainIndex * 1_000 + index;
        const outcomeId = 5_000 + chainIndex * 1_000 + index;
        const executable = index < 42 || (index >= 70 && index < 88);
        const anchorDeliveredAt = 1_500 + index;
        insertCandidate.run(id, chain, `product-pool-${chain}-${index}`);
        insertSignal.run(signalId, id);
        insertOutbox.run(outcomeId, signalId, anchorDeliveredAt);
        insertOutcome.run(
          outcomeId,
          signalId,
          anchorDeliveredAt,
          executable ? 'executable' : 'not_executable',
          executable ? 500 + index : null,
          JSON.stringify([
            executable
              ? {
                  horizonSeconds: 3600,
                  status: 'complete',
                  forwardReturn: index % 2 === 0 ? '0.1' : '-0.1',
                  mfe: '0.2',
                  mae: '-0.2',
                }
              : { horizonSeconds: 3600, status: 'incomplete', reason: 'entry:missing' },
          ]),
        );
      }
    }
    database.close();

    const result = spawnSync(process.execPath, ['scripts/level1-cohort-report.mjs'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, BOT_DATABASE_PATH: databasePath, CONFIG_VERSION_ID: '1' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.chains.sol.valid_batch_candidates, 5);
    assert.equal(report.chains.sol.clean_batch_candidates, 4);
    assert.equal(report.chains.sol.supplier_deferred_candidates, 3);
    assert.deepEqual(report.chains.sol.level1_latency, {
      samples: 4,
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
    assert.equal(report.chains.sol.rest_calls.batch, 1);
    assert.equal(report.chains.sol.backlog.due, 1);
    assert.ok(report.chains.sol.backlog.oldest_wait_ms >= 59_000);
    assert.ok(report.chains.sol.backlog.oldest_wait_ms < 65_000);
    assert.equal(report.credits.used_delta, 4);
    assert.equal(report.cohort.ended_at, 2_000);
    assert.equal(report.chains.sol.product_review.solidified_60m, 100);
    assert.equal(
      report.chains.sol.product_review.overall.horizons['3600']
        .executable_complete_rate_wilson_95.numerator,
      60,
    );
    assert.equal(
      report.chains.sol.product_review.overall.horizons['3600']
        .positive_return_rate_wilson_95.numerator,
      30,
    );
    assert.equal(
      report.chains.sol.product_review.overall.horizons['3600'].forward_return.min,
      -0.1,
    );
    assert.equal(
      report.chains.sol.product_review.overall.delivery_to_entry_latency.samples,
      60,
    );
    assert.equal(report.chains.sol.product_review.validation.anchors, 30);
    assert.equal(
      report.chains.sol.product_review.validation.horizons['3600']
        .executable_complete_rate_wilson_95.numerator,
      18,
    );
    assert.equal(report.chains.sol.product_review.product_review_ready, true);
    assert.equal(report.product_review_ready, true);
    assert.equal(report.recommendation, 'hold_shadow');

    const malformedDatabase = new Database(databasePath);
    malformedDatabase
      .prepare(
        `INSERT INTO candidates
         (id, chain, config_version_id, safety_status, status, funnel_status, pool_address,
          last_seen_at, safety_json, updated_at)
         VALUES (9999, 'bsc', 1, 'fatal', 'completed', 'completed', 'bad-pool', 0, '{}', 0)`,
      )
      .run();
    malformedDatabase
      .prepare('INSERT INTO signals (id, candidate_id, config_version_id) VALUES (9999, 9999, 1)')
      .run();
    malformedDatabase
      .prepare(
        `INSERT INTO delivery_outbox
         (id, signal_id, destination, message_type, status, delivery_uncertain, sent_at)
         VALUES (9999, 9999, 'admin_private', 'ENTRY_SIGNAL', 'sent', 0, 1900)`,
      )
      .run();
    malformedDatabase
      .prepare(
        `INSERT INTO outcomes
         (id, signal_id, config_version_id, anchor_destination, anchor_delivered_at,
          execution_status, delivery_to_entry_latency_ms, horizon_results_json)
         VALUES (9999, 9999, 1, 'admin_private', 1900, 'executable', 1,
                 '[{"horizonSeconds":3600,"status":"complete","forwardReturn":null,"mfe":"0.2","mae":"-0.2"}]')`,
      )
      .run();
    malformedDatabase.close();
    const malformedResult = spawnSync(process.execPath, ['scripts/level1-cohort-report.mjs'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, BOT_DATABASE_PATH: databasePath, CONFIG_VERSION_ID: '1' },
      encoding: 'utf8',
    });
    assert.equal(malformedResult.status, 0, malformedResult.stderr);
    const malformedReport = JSON.parse(malformedResult.stdout);
    assert.equal(malformedReport.chains.bsc.product_review.malformed_or_missing_horizons, 1);
    assert.equal(malformedReport.chains.bsc.product_review.gates.outcome_shape_valid, false);
    assert.equal(malformedReport.product_review_ready, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
