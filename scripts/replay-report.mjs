#!/usr/bin/env node
import { gunzipSync } from 'node:zlib';

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
    values[name] = value;
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

function normalizeToken(chain, value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return chain === 'bsc' ? value.toLowerCase() : value;
}

function tokenFromId(chain, value) {
  if (typeof value !== 'string') return undefined;
  const prefix = chain === 'bsc' ? 'bsc_' : 'solana_';
  return normalizeToken(chain, value.startsWith(prefix) ? value.slice(prefix.length) : value);
}

function discoveryFromEvent(row, payload) {
  const source = row.capability.endsWith('trending.1m')
    ? 'trending_1m'
    : row.capability.endsWith('trending.5m')
      ? 'trending_5m'
      : row.capability.endsWith('hot-searches.1m')
        ? 'hot_searches'
        : undefined;
  if (!source || !row.chain) return [];
  const tokens = source === 'hot_searches'
    ? (Array.isArray(payload) ? payload.find((item) => item?.chain === row.chain)?.tokens ?? [] : [])
    : payload?.data?.rank;
  if (!Array.isArray(tokens)) return [];
  return tokens.flatMap((token, index) => {
    const tokenAddress = normalizeToken(row.chain, token?.address ?? token?.token_address);
    if (!tokenAddress) return [];
    const visitingCount = Number.isSafeInteger(token?.visiting_count) ? token.visiting_count : undefined;
    return [{
      chain: row.chain,
      tokenAddress,
      source,
      observedAt: row.observed_at,
      ...(source === 'hot_searches' && visitingCount !== undefined ? { visitingCount } : {}),
      ...(source !== 'hot_searches' ? { rank: index + 1 } : {}),
    }];
  });
}

function poolIdentityMap(database, start, end, maxScanRows) {
  const pools = new Map();
  const rows = database
    .prepare(
      `SELECT chain, observed_at, payload_encoding, payload
       FROM provider_events
       WHERE provider = 'coingecko' AND capability = 'pools.multi.level1'
         AND observed_at >= ? AND observed_at <= ?
       ORDER BY observed_at, id LIMIT ?`,
    )
    .iterate(start, end, maxScanRows);
  for (const row of rows) {
    if (!row.chain) continue;
    let payload;
    try { payload = decodePayload(row); } catch { continue; }
    for (const item of payload?.data ?? []) {
      const poolAddress = item?.attributes?.address ?? item?.id?.split('_').at(-1);
      const base = tokenFromId(row.chain, item?.relationships?.base_token?.data?.id);
      const quote = tokenFromId(row.chain, item?.relationships?.quote_token?.data?.id);
      if (typeof poolAddress !== 'string') continue;
      const identities = [base, quote]
        .filter(Boolean)
        .map((tokenAddress) => ({ chain: row.chain, tokenAddress, poolAddress }));
      if (identities.length > 0) pools.set(`${row.chain}:${poolAddress}`, identities);
    }
  }
  return pools;
}

async function loadRuntime() {
  const [{ loadConfig }, { openDatabase }, { runReplay }, { buildOutcomeReport }] = await Promise.all([
    import('../dist/config/load.js'),
    import('../dist/persistence/db.js'),
    import('../dist/replay/runner.js'),
    import('../dist/outcomes/report.js'),
  ]);
  const loaded = await loadConfig('/app/config/bot.yaml');
  const database = openDatabase(loaded.config.storage.database_path, {
    busyTimeoutMs: loaded.config.storage.busy_timeout_ms,
  });
  return { loaded, database, runReplay, buildOutcomeReport };
}

async function runReplayCommand(values) {
  const { loaded, database, runReplay } = await loadRuntime();
  try {
    const configuredVersion = database.prepare(
      'SELECT id FROM rule_config_versions WHERE config_hash = ? AND git_commit = ? AND run_mode = ?',
    ).pluck().get(loaded.configHash, loaded.gitCommit, loaded.runMode);
    const configVersionId = integerOption(values, 'config-version', Number(configuredVersion));
    if (!configVersionId) throw new Error('no matching saved config version');
    const maxScanRows = loaded.config.replay.max_scan_rows;
    const cutoff = integerOption(
      values,
      'cutoff',
      Number(database.prepare('SELECT MAX(observed_at) FROM provider_events').pluck().get() ?? 0),
    );
    const start = integerOption(values, 'start', 0);
    const end = integerOption(values, 'end', cutoff);
    if (end > cutoff) throw new Error('--end cannot exceed --cutoff');
    const rows = database
      .prepare(
        `SELECT provider, capability, chain, token_address, pool_address, observed_at,
                payload_encoding, payload
         FROM provider_events
         WHERE observed_at >= ? AND observed_at <= ?
           AND ((provider = 'gmgn' AND capability LIKE 'market.%')
             OR (provider = 'coingecko' AND capability IN ('pools.multi.level1', 'G2', 'ohlcv.30s', 'trades.level1')))
         ORDER BY observed_at, id LIMIT ?`,
      )
      .iterate(start, end, maxScanRows);
    const discovery = [];
    const evidence = [];
    const pools = poolIdentityMap(database, start, end, maxScanRows);
    let scannedEvents = 0;
    for (const row of rows) {
      scannedEvents += 1;
      let payload;
      try { payload = decodePayload(row); } catch { continue; }
      discovery.push(...discoveryFromEvent(row, payload));
      const isDiscovery = row.provider === 'gmgn' && row.capability.startsWith('market.');
      if (isDiscovery && row.chain) {
        for (const observation of discoveryFromEvent(row, payload))
          evidence.push({ kind: 'safety', chain: row.chain, tokenAddress: observation.tokenAddress, observedAt: row.observed_at, payload });
      }
      if (row.provider !== 'coingecko') continue;
      if (row.capability === 'G2' && row.chain && row.pool_address) {
        const identities = pools.get(`${row.chain}:${row.pool_address}`) ?? [];
        for (const identity of identities)
          evidence.push({ kind: 'g2', ...identity, observedAt: row.observed_at, payload });
      } else if (row.capability === 'ohlcv.30s' && row.chain && row.pool_address && row.token_address) {
        evidence.push({ kind: 'ohlcv', chain: row.chain, poolAddress: row.pool_address, tokenAddress: normalizeToken(row.chain, row.token_address), observedAt: row.observed_at, payload });
      } else if (row.capability === 'trades.level1' && row.chain && row.pool_address && row.token_address) {
        evidence.push({ kind: 'trades', chain: row.chain, poolAddress: row.pool_address, tokenAddress: normalizeToken(row.chain, row.token_address), observedAt: row.observed_at, payload });
      }
    }
    let lastBacklogCheck = 0;
    const result = runReplay({
      database,
      configVersionId,
      gitCommit: loaded.gitCommit,
      runMode: loaded.runMode,
      dataStartAt: start,
      dataEndAt: end,
      dataCutoffAt: cutoff,
      now: Date.now(),
      startedAt: Date.now(),
      deliveryDelayMs: loaded.config.replay.delivery_delay_ms,
      candidateTtlSeconds: Math.max(
        loaded.config.chains.sol.discovery.candidate_ttl_seconds,
        loaded.config.chains.bsc.discovery.candidate_ttl_seconds,
      ),
      outcomeMaxLatenessSeconds: loaded.config.outcomes.outcome_max_lateness_seconds,
      horizonSeconds: loaded.config.outcomes.horizons_seconds,
      discovery,
      evidence,
      resultBatchSize: loaded.config.replay.result_write_batch,
      worktreeStatus: '',
      shouldYield: () => {
        const now = Date.now();
        if (now - lastBacklogCheck < 1000) return false;
        lastBacklogCheck = now;
        const latestObservedAt = Number(
          database.prepare('SELECT MAX(observed_at) FROM provider_events').pluck().get() ?? 0,
        );
        return latestObservedAt > cutoff;
      },
    });
    console.log(JSON.stringify({ ...result, scannedEvents, discovery: discovery.length, evidence: evidence.length }));
  } finally {
    database.close();
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
