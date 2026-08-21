import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { openDatabase, runMigrations, schemaVersion } from './db.js';
import { migrations } from './migrations.js';
import { parseConfigText } from '../config/load.js';
import { readFile } from 'node:fs/promises';
import { ensureConfigVersion } from './config-versions.js';
import { insertProviderEvent } from './provider-events.js';
import { EventLoopLagMonitor } from './event-loop-lag.js';
import { boundedWrite, WriteBudgetExceededError } from './write-budget.js';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function memoryDatabase() {
  return openDatabase(':memory:', { busyTimeoutMs: 250 });
}

test('runs numbered migration and creates exactly ten business tables', () => {
  const database = memoryDatabase();
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .pluck()
    .all();
  assert.deepEqual(tables, [
    'candidates',
    'candles_30s',
    'delivery_outbox',
    'outcomes',
    'provider_events',
    'replay_results',
    'replay_runs',
    'rule_config_versions',
    'signals',
    'trades',
  ]);
  assert.equal(schemaVersion(database), 2);
  const outcomeColumns = database.prepare('PRAGMA table_info(outcomes)').all() as Array<{
    name: string;
  }>;
  assert.ok(outcomeColumns.some((column) => column.name === 'delivery_to_entry_latency_ms'));
  assert.equal(database.pragma('foreign_keys', { simple: true }), 1);
  const indexes = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .pluck()
    .all();
  assert.deepEqual(indexes, [
    'candidates_active_idx',
    'candles_identity_idx',
    'outbox_due_idx',
    'outcomes_config_time_idx',
    'provider_events_identity_idx',
    'provider_events_observed_idx',
    'replay_results_run_key_idx',
    'trades_identity_idx',
  ]);
  type QueryPlanRow = { detail: string };
  const plans: QueryPlanRow[] = [
    ...(database
      .prepare('EXPLAIN QUERY PLAN SELECT id FROM provider_events WHERE observed_at >= ?')
      .all(0) as QueryPlanRow[]),
    ...(database
      .prepare('EXPLAIN QUERY PLAN SELECT id FROM delivery_outbox WHERE status = ? AND due_at <= ?')
      .all('pending', 0) as QueryPlanRow[]),
    ...(database
      .prepare(
        'EXPLAIN QUERY PLAN SELECT id FROM candidates WHERE chain = ? AND token_address = ? AND status = ?',
      )
      .all('sol', 'token', 'active') as QueryPlanRow[]),
    ...(database
      .prepare(
        'EXPLAIN QUERY PLAN SELECT id FROM outcomes WHERE config_version_id = ? AND anchor_delivered_at > ?',
      )
      .all(1, 0) as QueryPlanRow[]),
    ...(database
      .prepare(
        'EXPLAIN QUERY PLAN SELECT id FROM replay_results WHERE replay_run_id = ? AND simulated_candidate_key = ?',
      )
      .all(1, 'sol:token:1') as QueryPlanRow[]),
  ];
  assert.ok(
    plans.every(
      (plan) => typeof plan.detail === 'string' && /USING (COVERING )?INDEX/u.test(plan.detail),
    ),
  );
  database.close();
});

test('rejects migration version gaps instead of corrupting schema version', () => {
  const database = new Database(':memory:');
  assert.throws(
    () => runMigrations(database, [{ version: 2, name: '002_gap', sql: 'SELECT 1' }]),
    /sequence gap/u,
  );
  assert.equal(schemaVersion(database), 0);
  database.close();
});

test('upgrades an existing schema with the outcome latency column', () => {
  const database = new Database(':memory:');
  runMigrations(database, migrations.slice(0, 1));
  assert.equal(schemaVersion(database), 1);
  runMigrations(database, migrations);
  assert.equal(schemaVersion(database), 2);
  const columns = database.prepare('PRAGMA table_info(outcomes)').all() as Array<{ name: string }>;
  assert.ok(columns.some((column) => column.name === 'delivery_to_entry_latency_ms'));
  database.close();
});

test('file database enables WAL mode', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'meme-signal-db-'));
  const databasePath = path.join(directory, 'bot.sqlite');
  const database = openDatabase(databasePath, { busyTimeoutMs: 250 });
  assert.equal(database.pragma('journal_mode', { simple: true }), 'wal');
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

test('config version is immutable and reused by its complete identity', async () => {
  const database = memoryDatabase();
  const loaded = parseConfigText(
    await readFile(new URL('../../config/bot.yaml', import.meta.url), 'utf8'),
  );
  const input = {
    config: loaded.config,
    configHash: loaded.configHash,
    gitCommit: 'test-commit',
    normalizedYaml: loaded.normalizedYaml,
    createdAt: 1000,
  };
  const first = ensureConfigVersion(database, input, { maxRows: 5, maxMs: 100 });
  const second = ensureConfigVersion(
    database,
    { ...input, createdAt: 2000 },
    { maxRows: 5, maxMs: 100 },
  );
  assert.equal(first.id, second.id);
  const count = database.prepare('SELECT COUNT(*) AS count FROM rule_config_versions').get() as {
    count: number;
  };
  assert.equal(count.count, 1);
  database.close();
});

test('provider event payload is compressed and request secrets are not persisted', () => {
  const database = memoryDatabase();
  const result = insertProviderEvent(
    database,
    {
      provider: 'test',
      capability: 'fixture',
      observedAt: 1000,
      schemaVersion: '1',
      payload: 'a'.repeat(5000),
      requestMeta: {
        endpoint_name: 'fixture',
        authorization: 'secret',
        api_key: 'secret',
        method: 'GET',
      },
    },
    { maxRows: 5, maxMs: 100 },
  );
  const row = database
    .prepare(
      'SELECT payload_encoding, request_meta_json, payload FROM provider_events WHERE id = ?',
    )
    .get(result.id) as { payload_encoding: string; request_meta_json: string; payload: Buffer };
  assert.equal(row.payload_encoding, 'gzip');
  assert.equal(row.request_meta_json, JSON.stringify({ endpoint_name: 'fixture', method: 'GET' }));
  assert.equal(row.payload.toString('utf8').includes('secret'), false);
  database.close();
});

test('event loop lag monitor marks a window incomplete over threshold', () => {
  const monitor = new EventLoopLagMonitor(10, 25);
  assert.equal(monitor.record(30).incomplete, true);
  assert.equal(monitor.snapshot().maxLagMs, 30);
  assert.equal(monitor.record(0).incomplete, true);
  monitor.resetWindow();
  assert.equal(monitor.snapshot().incomplete, false);
  monitor.stop();
});

test('row budget overflow is a typed, rollback-safe error', () => {
  const database = memoryDatabase();
  database.exec('CREATE TABLE write_probe (id INTEGER PRIMARY KEY)');
  assert.throws(
    () =>
      boundedWrite(database, { maxRows: 1, maxMs: 100 }, (context) => {
        database.prepare('INSERT INTO write_probe (id) VALUES (1)').run();
        context.addRows(1);
        context.addRows(1);
      }),
    (error: unknown) =>
      error instanceof WriteBudgetExceededError && error.code === 'WRITE_BUDGET_EXCEEDED',
  );
  assert.deepEqual(
    database.prepare('SELECT COUNT(*) AS count FROM write_probe').get() as { count: number },
    { count: 0 },
  );
  database.close();
});
