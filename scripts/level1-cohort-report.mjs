#!/usr/bin/env node

import { gunzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import YAML from 'yaml';

const databasePath = process.env.BOT_DATABASE_PATH ?? 'data/bot.sqlite';
const requestedVersion = process.env.CONFIG_VERSION_ID
  ? Number(process.env.CONFIG_VERSION_ID)
  : undefined;
const database = new Database(databasePath, { readonly: true, fileMustExist: true });

function decode(row) {
  const bytes = row.payload_encoding === 'gzip' ? gunzipSync(row.payload) : row.payload;
  return JSON.parse(bytes.toString('utf8'));
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function naturalKey(chain, tokenAddress, poolAddress, cycleStartedAt) {
  const normalize = (value) => (chain === 'bsc' ? value.toLowerCase() : value);
  return `${chain}:${normalize(tokenAddress)}:${normalize(poolAddress)}:${cycleStartedAt}`;
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function latencySummary(values) {
  return {
    samples: values.length,
    p50_ms: percentile(values, 0.5),
    p95_ms: percentile(values, 0.95),
    max_ms: values.length === 0 ? null : Math.max(...values),
  };
}

const cohort = requestedVersion
  ? database
      .prepare(
        `SELECT id, config_hash, git_commit, run_mode, yaml_snapshot, created_at
         FROM rule_config_versions WHERE id = ?`,
      )
      .get(requestedVersion)
  : database
      .prepare(
        `SELECT id, config_hash, git_commit, run_mode, yaml_snapshot, created_at
         FROM rule_config_versions ORDER BY id DESC LIMIT 1`,
      )
      .get();
if (!cohort) throw new Error('Requested config version does not exist');
const cohortConfig = YAML.parse(cohort.yaml_snapshot);
delete cohort.yaml_snapshot;

const runtimeRows = database
  .prepare(
    `SELECT chain, token_address, pool_address, observed_at, payload_encoding, payload
     FROM provider_events
     WHERE provider = 'runtime' AND capability = 'scheduler.decision'
       AND observed_at >= ? ORDER BY observed_at, id`,
  )
  .all(cohort.created_at)
  .flatMap((row) => {
    try {
      const payload = record(decode(row));
      return String(payload.configVersionId) === String(cohort.id)
        ? [
            {
              chain: row.chain,
              tokenAddress: row.token_address,
              poolAddress: row.pool_address,
              observedAt: row.observed_at,
              payload,
            },
          ]
        : [];
    } catch {
      return [];
    }
  });

const chains = { sol: createChainState(), bsc: createChainState() };
let globalRateLimited429 = 0;
for (const event of runtimeRows) {
  if (event.chain !== 'sol' && event.chain !== 'bsc') {
    if (event.payload.decision === 'rate_limited') globalRateLimited429 += 1;
    continue;
  }
  const state = chains[event.chain];
  const decision = event.payload.decision;
  const reason = typeof event.payload.reason === 'string' ? event.payload.reason : '';
  const eventTime = Number(event.payload.eventTime ?? event.observedAt);
  const candidates = Array.isArray(event.payload.candidates) ? event.payload.candidates : [];

  if (decision === 'rate_limited') state.rateLimited429 += 1;
  if (decision === 'defer') {
    state.defers[reason] = (state.defers[reason] ?? 0) + 1;
    for (const value of candidates) {
      const candidate = record(value);
      const key = candidateKey(event.chain, candidate);
      if (key && /429|credit|rate/u.test(reason)) state.supplierDeferred.add(key);
    }
  }
  if (decision === 'complete') {
    for (const value of candidates) {
      const candidate = record(value);
      const key = candidateKey(event.chain, candidate);
      if (!key) continue;
      state.batchAttempts += 1;
      if (candidate.screeningStatus !== 'complete') continue;
      const dueAt = Number(candidate.dueAt);
      if (!Number.isSafeInteger(dueAt) || dueAt < cohort.created_at || eventTime < dueAt) {
        state.invalidBatchClocks += 1;
        continue;
      }
      const existing = state.batchCandidates.get(key);
      if (!existing || eventTime < existing.completedAt)
        state.batchCandidates.set(key, { dueAt, completedAt: eventTime });
    }
  }

  const singleKey = singleEventKey(event);
  if (!singleKey) continue;
  if (decision === 'reservation_acquired') state.activeReservations.set(singleKey, eventTime);
  if (decision === 'reservation_released' || decision === 'reservation_preempted')
    state.activeReservations.delete(singleKey);
  if (decision === 'armed') {
    const reservationAt = state.activeReservations.get(singleKey);
    if (reservationAt !== undefined && eventTime >= reservationAt) {
      const existing = state.finalists.get(singleKey);
      if (!existing || eventTime < existing.armedAt)
        state.finalists.set(singleKey, { reservationAt, armedAt: eventTime });
    } else {
      state.invalidFinalistClocks += 1;
    }
    state.activeReservations.delete(singleKey);
  }
}

const requestRows = database
  .prepare(
    `SELECT chain, capability, COUNT(*) AS calls
     FROM provider_events
     WHERE provider = 'coingecko' AND observed_at >= ?
       AND capability IN ('pools.multi.level1', 'trades.level1')
     GROUP BY chain, capability`,
  )
  .all(cohort.created_at);
for (const row of requestRows) {
  if (row.chain !== 'sol' && row.chain !== 'bsc') continue;
  if (row.capability === 'pools.multi.level1') chains[row.chain].batchCalls = Number(row.calls);
  if (row.capability === 'trades.level1') chains[row.chain].tradeCalls = Number(row.calls);
}

const keyCreditSamples = database
  .prepare(
    `SELECT payload_encoding, payload FROM provider_events
     WHERE provider = 'coingecko' AND capability = 'key' AND observed_at >= ?
     ORDER BY observed_at`,
  )
  .all(cohort.created_at)
  .flatMap((row) => {
    try {
      const used = Number(record(decode(row)).api_key_current_total_monthly_calls);
      return Number.isSafeInteger(used) ? [used] : [];
    } catch {
      return [];
    }
  });

const reportNow = Date.now();
const currentBacklogRows = database
  .prepare(
    `SELECT chain, status, funnel_status, updated_at, last_seen_at, safety_json
     FROM candidates
     WHERE config_version_id = ? AND safety_status = 'pass' AND status != 'expired'
       AND pool_address IS NOT NULL`,
  )
  .all(cohort.id);
const backlogByChain = {
  sol: { due: 0, oldest_wait_ms: 0 },
  bsc: { due: 0, oldest_wait_ms: 0 },
};
for (const row of currentBacklogRows) {
  if (row.chain !== 'sol' && row.chain !== 'bsc') continue;
  const chainConfig = cohortConfig.chains?.[row.chain];
  const expiresAt = Number(record(parseJson(row.safety_json)).expiresAt);
  const candidateFresh =
    Number(row.last_seen_at) >=
    reportNow - Number(chainConfig?.discovery?.candidate_ttl_seconds) * 1000;
  if ((Number.isFinite(expiresAt) && expiresAt <= reportNow) || !candidateFresh) continue;
  const active = ['armed', 'confirmed-pending-anchor', 'delivered'].includes(row.status);
  const unscreened = !['level1_screened', 'level1_checked'].includes(row.funnel_status);
  const delaySeconds = active
    ? Number(chainConfig?.level1?.refresh_interval_seconds)
    : unscreened
      ? 0
      : Number(cohortConfig.providers?.coingecko?.scheduler?.dynamic_recheck_seconds);
  if (!Number.isFinite(delaySeconds)) throw new Error('Cohort refresh cadence is invalid');
  const dueAt = Number(row.updated_at) + delaySeconds * 1000;
  if (dueAt > reportNow) continue;
  const backlog = backlogByChain[row.chain];
  backlog.due += 1;
  backlog.oldest_wait_ms = Math.max(backlog.oldest_wait_ms, reportNow - dueAt);
}

const lifecycleRows = database
  .prepare(
    `SELECT c.chain, COUNT(DISTINCT s.id) AS signals,
            COUNT(DISTINCT o.id) AS outcomes
     FROM candidates c
     LEFT JOIN signals s ON s.candidate_id = c.id AND s.config_version_id = ?
     LEFT JOIN outcomes o ON o.signal_id = s.id AND o.config_version_id = ?
     WHERE c.config_version_id = ? GROUP BY c.chain`,
  )
  .all(cohort.id, cohort.id, cohort.id);
const lifecycleByChain = Object.fromEntries(
  lifecycleRows.map((row) => [
    row.chain,
    { signals: Number(row.signals), outcomes: Number(row.outcomes) },
  ]),
);

const chainReports = {};
for (const chain of ['sol', 'bsc']) {
  const state = chains[chain];
  const totalRateLimited429 = state.rateLimited429 + globalRateLimited429;
  const cleanBatchLatencies = [...state.batchCandidates.entries()]
    .filter(([key]) => !state.supplierDeferred.has(key))
    .map(([, value]) => value.completedAt - value.dueAt);
  const finalistLatencies = [...state.finalists.values()].map(
    (value) => value.armedAt - value.reservationAt,
  );
  const newCalls = state.batchCalls + state.tradeCalls;
  const legacyEstimatedCalls = state.batchCalls + state.batchAttempts;
  const reduction = legacyEstimatedCalls === 0 ? null : 1 - newCalls / legacyEstimatedCalls;
  const level1Latency = latencySummary(cleanBatchLatencies);
  const finalistLatency = latencySummary(finalistLatencies);
  const gates = {
    batch_samples_500: state.batchCandidates.size >= 500,
    finalist_samples_50: state.finalists.size >= 50,
    level1_p95_lte_10s: level1Latency.p95_ms !== null && level1Latency.p95_ms <= 10_000,
    finalist_p95_lte_10s: finalistLatency.p95_ms !== null && finalistLatency.p95_ms <= 10_000,
    rest_calls_reduction_gte_80_percent: reduction !== null && reduction >= 0.8,
    local_429_zero: totalRateLimited429 === 0,
    clocks_valid: state.invalidBatchClocks === 0 && state.invalidFinalistClocks === 0,
  };
  chainReports[chain] = {
    valid_batch_candidates: state.batchCandidates.size,
    clean_batch_candidates: cleanBatchLatencies.length,
    finalist_to_g2_samples: state.finalists.size,
    level1_latency: level1Latency,
    finalist_to_g2_latency: finalistLatency,
    rest_calls: {
      batch: state.batchCalls,
      trades: state.tradeCalls,
      new_total: newCalls,
      legacy_estimated_total: legacyEstimatedCalls,
      reduction_percent: reduction === null ? null : Number((reduction * 100).toFixed(2)),
    },
    rate_limited_429: totalRateLimited429,
    defers: state.defers,
    supplier_deferred_candidates: state.supplierDeferred.size,
    invalid_clocks: {
      batch: state.invalidBatchClocks,
      finalist: state.invalidFinalistClocks,
    },
    backlog: backlogByChain[chain] ?? { due: 0, oldest_wait_ms: 0 },
    lifecycle: lifecycleByChain[chain] ?? { signals: 0, outcomes: 0 },
    gates,
    engineering_ready: Object.values(gates).every(Boolean),
  };
}

const engineeringReady = Object.values(chainReports).every((report) => report.engineering_ready);
const result = {
  generated_at: Date.now(),
  cohort,
  credits: {
    samples: keyCreditSamples.length,
    first_used: keyCreditSamples[0] ?? null,
    last_used: keyCreditSamples.at(-1) ?? null,
    used_delta: keyCreditSamples.length < 2 ? null : keyCreditSamples.at(-1) - keyCreditSamples[0],
  },
  chains: chainReports,
  engineering_ready: engineeringReady,
  recommendation: engineeringReady ? 'ready_for_product_review' : 'hold_shadow',
};

console.log(JSON.stringify(result, null, 2));
database.close();

function createChainState() {
  return {
    batchCandidates: new Map(),
    batchAttempts: 0,
    supplierDeferred: new Set(),
    activeReservations: new Map(),
    finalists: new Map(),
    batchCalls: 0,
    tradeCalls: 0,
    rateLimited429: 0,
    defers: {},
    invalidBatchClocks: 0,
    invalidFinalistClocks: 0,
  };
}

function candidateKey(chain, candidate) {
  const tokenAddress = candidate.tokenAddress;
  const poolAddress = candidate.poolAddress;
  const cycleStartedAt = Number(candidate.cycleStartedAt);
  return typeof tokenAddress === 'string' &&
    typeof poolAddress === 'string' &&
    Number.isSafeInteger(cycleStartedAt)
    ? naturalKey(chain, tokenAddress, poolAddress, cycleStartedAt)
    : undefined;
}

function singleEventKey(event) {
  const tokenAddress = event.tokenAddress;
  const poolAddress = event.poolAddress;
  const cycleStartedAt = Number(event.payload.cycleStartedAt);
  return typeof tokenAddress === 'string' &&
    typeof poolAddress === 'string' &&
    Number.isSafeInteger(cycleStartedAt)
    ? naturalKey(event.chain, tokenAddress, poolAddress, cycleStartedAt)
    : undefined;
}
