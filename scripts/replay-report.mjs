#!/usr/bin/env node
import { readFileSync, rmSync } from 'node:fs';
import { setPriority } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const DEFAULT_REPLAY_WINDOW_MS = 15 * 60 * 1000;

function requireCleanMain() {
  if (process.env.CONTAINERIZED_RUN !== '1')
    throw new Error('replay/report wrapper must run inside the versioned container');
  if (!process.env.BUILD_GIT_COMMIT || process.env.BUILD_GIT_COMMIT === 'unknown')
    throw new Error('replay/report wrapper requires a versioned image');
  if (process.env.BUILD_WORKTREE_STATUS !== '')
    throw new Error('replay/report wrapper requires a clean worktree at image build');
}

function parseArgs(argv) {
  const command = argv[0];
  const values = {};
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`invalid argument: ${argument}`);
    const name = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${name}`);
    if (name === 'set') values.set = [...(values.set ?? []), value];
    else values[name] = value;
    index += 1;
  }
  return { command, values };
}

function integerOption(values, name, fallback) {
  const raw = values[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid --${name}`);
  return value;
}

function decodePayload(row) {
  const bytes = Buffer.from(row.payload);
  const text = row.payload_encoding === 'gzip' ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
  return JSON.parse(text);
}

async function loadRuntime() {
  const [
    { loadConfig },
    { openDatabase },
    { runReplay, startReplayRun, failReplayRun },
    { buildOutcomeReport },
    { createReplayBackup },
    { simulateReplay },
    { loadReplayConfig },
    { ensureConfigVersion },
    { default: Database },
    { extractReplayProviderEvent },
  ] = await Promise.all([
    import('../dist/config/load.js'),
    import('../dist/persistence/db.js'),
    import('../dist/replay/runner.js'),
    import('../dist/outcomes/report.js'),
    import('../dist/replay/backup.js'),
    import('../dist/replay/simulator.js'),
    import('../dist/replay/config.js'),
    import('../dist/persistence/config-versions.js'),
    import('better-sqlite3'),
    import('../dist/replay/provider-events.js'),
  ]);
  const loaded = await loadConfig('/app/config/bot.yaml');
  const database = openDatabase(loaded.config.storage.database_path, {
    busyTimeoutMs: loaded.config.storage.busy_timeout_ms,
  });
  return {
    loaded,
    database,
    runReplay,
    startReplayRun,
    failReplayRun,
    buildOutcomeReport,
    createReplayBackup,
    simulateReplay,
    loadReplayConfig,
    ensureConfigVersion,
    Database,
    extractReplayProviderEvent,
  };
}

async function runReplayCommand(values) {
  try {
    setPriority(0, 10);
  } catch {
    throw new Error('replay could not lower its CPU scheduling priority');
  }
  const runtime = await loadRuntime();
  const {
    database,
    runReplay,
    startReplayRun,
    failReplayRun,
    createReplayBackup,
    simulateReplay,
    loadReplayConfig,
    ensureConfigVersion,
    Database,
    extractReplayProviderEvent,
  } = runtime;
  let loaded = runtime.loaded;
  let snapshot;
  let snapshotPath;
  let runId;
  try {
    database
      .prepare(
        "UPDATE replay_runs SET status = 'failed', error_message = ?, completed_at = ? WHERE status = 'running'",
      )
      .run('recovered stale replay process before new run', Date.now());
    const configuredVersion = database.prepare(
      'SELECT id FROM rule_config_versions WHERE config_hash = ? AND git_commit = ? AND run_mode = ?',
    ).pluck().get(loaded.configHash, loaded.gitCommit, loaded.runMode);
    let configVersionId = integerOption(values, 'config-version', Number(configuredVersion));
    if (!configVersionId) throw new Error('no matching saved config version');
    const overrides = values.set ?? [];
    if (overrides.length > 0) {
      const saved = database
        .prepare('SELECT yaml_snapshot FROM rule_config_versions WHERE id = ?')
        .get(configVersionId);
      if (!saved) throw new Error('unknown saved config version');
      loaded = loadReplayConfig({
        savedConfigYaml: saved.yaml_snapshot,
        overrides,
        worktreeStatus: '',
      });
      configVersionId = ensureConfigVersion(
        database,
        {
          config: loaded.config,
          configHash: loaded.configHash,
          gitCommit: loaded.gitCommit,
          normalizedYaml: loaded.normalizedYaml,
          createdAt: Date.now(),
        },
        {
          maxRows: loaded.config.runtime.sqlite.transaction_max_rows,
          maxMs: loaded.config.runtime.sqlite.transaction_max_ms,
        },
      ).id;
    } else if (configVersionId !== Number(configuredVersion)) {
      throw new Error('--config-version requires at least one --set override');
    }
    const maxScanRows = loaded.config.replay.max_scan_rows;
    const cutoff = integerOption(
      values,
      'cutoff',
      Number(database.prepare('SELECT MAX(observed_at) FROM provider_events').pluck().get() ?? 0),
    );
    const start = integerOption(
      values,
      'start',
      Math.max(0, cutoff - DEFAULT_REPLAY_WINDOW_MS),
    );
    const end = integerOption(values, 'end', cutoff);
    if (end > cutoff) throw new Error('--end cannot exceed --cutoff');
    if (start > end) throw new Error('--start cannot exceed --end');
    const replayWarmupMs =
      loaded.config.strategies.emerging_breakout.cooldown_seconds * 1000 +
      Math.max(
        loaded.config.chains.sol.discovery.candidate_ttl_seconds,
        loaded.config.chains.bsc.discovery.candidate_ttl_seconds,
      ) * 1000;
    const scanStart = Math.max(0, start - replayWarmupMs);
    const startedAt = Date.now();
    runId = startReplayRun({
      database,
      configVersionId,
      gitCommit: loaded.gitCommit,
      runMode: loaded.runMode,
      dataStartAt: start,
      dataEndAt: end,
      dataCutoffAt: cutoff,
      startedAt,
    });
    snapshotPath = path.join(
      path.resolve(loaded.config.storage.replay_temp_directory),
      `replay-snapshot-${process.pid}-${Date.now()}.sqlite`,
    );
    await createReplayBackup(database, {
      destination: snapshotPath,
      pageBatch: loaded.config.replay.backup_page_batch,
      minimumFreeBytes: 1,
    });
    snapshot = new Database(snapshotPath, { readonly: true, fileMustExist: true });
    const rows = snapshot
      .prepare(
        `SELECT provider, capability, chain, token_address, pool_address, observed_at,
                payload_encoding, payload
         FROM provider_events
         WHERE observed_at >= ? AND observed_at <= ?
           AND ((provider = 'gmgn' AND capability LIKE 'market.%')
             OR (provider = 'coingecko' AND capability IN ('tokens.multi', 'pools.multi.level1', 'G2', 'ohlcv.30s', 'trades.level1')))
       ORDER BY observed_at, id LIMIT ?`,
      )
      .iterate(scanStart, cutoff, maxScanRows + 1);
    const discovery = [];
    const evidence = [];
    let scannedEvents = 0;
    for (const row of rows) {
      scannedEvents += 1;
      if (scannedEvents > maxScanRows)
        throw new Error(`replay scan exceeds configured max_scan_rows=${maxScanRows}`);
      let payload;
      try {
        payload = decodePayload(row);
      } catch {
        throw new Error(
          `invalid replay raw payload: ${row.provider}/${row.capability}@${row.observed_at}`,
        );
      }
      const extracted = extractReplayProviderEvent(row, payload);
      discovery.push(...extracted.discovery);
      evidence.push(...extracted.evidence);
    }
    const simulatedResults = simulateReplay({
      config: loaded.config,
      configVersionId,
      dataStartAt: start,
      dataEndAt: end,
      dataCutoffAt: cutoff,
      deliveryDelayMs: loaded.config.replay.delivery_delay_ms,
      discovery,
      evidence,
    });
    const result = runReplay({
      database,
      runId,
      configVersionId,
      gitCommit: loaded.gitCommit,
      runMode: loaded.runMode,
      dataStartAt: start,
      dataEndAt: end,
      dataCutoffAt: cutoff,
      now: Date.now(),
      startedAt,
      simulatedResults,
      resultBatchSize: loaded.config.replay.result_write_batch,
      worktreeStatus: '',
      shouldYield: () => replayShouldYield(loaded.config.storage.database_path),
    });
    console.log(JSON.stringify({ ...result, scannedEvents, discovery: discovery.length, evidence: evidence.length }));
  } catch (error) {
    if (runId !== undefined) failReplayRun(database, runId, error, Date.now());
    throw error;
  } finally {
    snapshot?.close();
    if (snapshotPath) {
      rmSync(snapshotPath, { force: true });
      rmSync(`${snapshotPath}-wal`, { force: true });
      rmSync(`${snapshotPath}-shm`, { force: true });
    }
    database.close();
  }
}

function replayShouldYield(databasePath) {
  try {
    const healthPath = path.join(path.dirname(path.resolve(databasePath)), 'runtime-health.json');
    const health = JSON.parse(readFileSync(healthPath, 'utf8'));
    return (
      health?.components?.sqlite !== 'ok' ||
      health?.components?.event_loop !== 'ok' ||
      health?.disk?.highWater === true ||
      health?.provider_probe?.g2QueueHighWater === true
    );
  } catch {
    return true;
  }
}

async function runReportCommand(values) {
  const { loaded, database, buildOutcomeReport } = await loadRuntime();
  try {
    const savedVersion = database
      .prepare(
        'SELECT id FROM rule_config_versions WHERE config_hash = ? AND git_commit = ? AND run_mode = ?',
      )
      .pluck()
      .get(loaded.configHash, loaded.gitCommit, loaded.runMode);
    const resolvedConfigVersionId = integerOption(values, 'config-version', Number(savedVersion));
    if (!Number.isSafeInteger(resolvedConfigVersionId) || resolvedConfigVersionId <= 0)
      throw new Error('no matching saved config version');
    const configVersionId = String(resolvedConfigVersionId);
    const end = integerOption(values, 'end', Date.now());
    const start = integerOption(values, 'start', 0);
    const maxRows = integerOption(values, 'max-rows', loaded.config.replay.max_scan_rows);
    const rows = database.prepare(
      `SELECT o.config_version_id, c.run_mode, o.anchor_delivered_at, o.execution_status,
              o.delivery_drift, o.delivery_to_entry_latency_ms, o.horizon_results_json
       FROM outcomes o JOIN rule_config_versions c ON c.id = o.config_version_id
       WHERE o.config_version_id = ? AND o.anchor_delivered_at BETWEEN ? AND ?
       ORDER BY o.anchor_delivered_at LIMIT ?`,
    ).all(Number(configVersionId), start, end, maxRows);
    const outcomes = rows.map((row) => ({
      configVersionId,
      runMode: row.run_mode,
      anchorDeliveredAt: row.anchor_delivered_at,
      executionStatus: row.execution_status,
      ...(row.delivery_drift === null ? {} : { deliveryDrift: row.delivery_drift }),
      ...(row.delivery_to_entry_latency_ms === null ? {} : { latencyMs: row.delivery_to_entry_latency_ms }),
      horizons: JSON.parse(row.horizon_results_json),
    }));
    console.log(JSON.stringify(buildOutcomeReport({
      outcomes,
      configVersionId,
      runMode: loaded.runMode,
      startAt: start,
      endAt: end,
      maxRows,
    })));
  } finally {
    database.close();
  }
}

const { command, values } = parseArgs(process.argv.slice(2));
if (command !== 'replay' && command !== 'report') {
  console.error('usage: CONTAINERIZED_RUN=1 node scripts/replay-report.mjs <replay|report>');
  process.exitCode = 2;
} else {
  requireCleanMain();
  try {
    if (command === 'replay') await runReplayCommand(values);
    else await runReportCommand(values);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
