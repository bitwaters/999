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

function finiteMetric(value) {
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'string' && value.trim() === '')
  )
    return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function rounded(value) {
  return Number(value.toFixed(6));
}

function wilson95(numerator, denominator) {
  if (denominator === 0)
    return { numerator, denominator, rate: null, lower: null, upper: null };
  const z = 1.959963984540054;
  const rate = numerator / denominator;
  const z2 = z * z;
  const denominatorAdjustment = 1 + z2 / denominator;
  const center = (rate + z2 / (2 * denominator)) / denominatorAdjustment;
  const margin =
    (z / denominatorAdjustment) *
    Math.sqrt((rate * (1 - rate) + z2 / (4 * denominator)) / denominator);
  return {
    numerator,
    denominator,
    rate: rounded(rate),
    lower: rounded(Math.max(0, center - margin)),
    upper: rounded(Math.min(1, center + margin)),
  };
}

function metricSummary(values) {
  if (values.length === 0)
    return { samples: 0, mean: null, median: null, p05: null, min: null, max: null };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: values.length,
    mean: rounded(values.reduce((sum, value) => sum + value, 0) / values.length),
    median: rounded(percentile(sorted, 0.5)),
    p05: rounded(percentile(sorted, 0.05)),
    min: rounded(sorted[0]),
    max: rounded(sorted.at(-1)),
  };
}

function horizonSlice(rows, horizonSeconds) {
  const horizonCounts = { complete: 0, late_entry: 0, incomplete: 0 };
  const executableComplete = [];
  for (const row of rows) {
    const horizon = row.horizons[String(horizonSeconds)];
    horizonCounts[horizon.status] += 1;
    if (row.executionStatus === 'executable' && horizon.status === 'complete')
      executableComplete.push(horizon);
  }
  const positiveReturns = executableComplete.filter((horizon) => horizon.forwardReturn > 0).length;
  return {
    status_counts: horizonCounts,
    complete_rate_wilson_95: wilson95(horizonCounts.complete, rows.length),
    executable_complete_rate_wilson_95: wilson95(executableComplete.length, rows.length),
    positive_return_rate_wilson_95: wilson95(positiveReturns, executableComplete.length),
    forward_return: metricSummary(executableComplete.map((horizon) => horizon.forwardReturn)),
    mfe: metricSummary(executableComplete.map((horizon) => horizon.mfe)),
    mae: metricSummary(executableComplete.map((horizon) => horizon.mae)),
  };
}

function productSlice(rows, horizonSeconds) {
  const executionCounts = { executable: 0, not_executable: 0, incomplete: 0 };
  const deliveryLatencies = [];
  for (const row of rows) {
    executionCounts[row.executionStatus] += 1;
    if (row.deliveryLatencyMs !== undefined) deliveryLatencies.push(row.deliveryLatencyMs);
  }
  return {
    anchors: rows.length,
    execution_counts: executionCounts,
    executable_rate_wilson_95: wilson95(executionCounts.executable, rows.length),
    horizons: Object.fromEntries(
      horizonSeconds.map((seconds) => [String(seconds), horizonSlice(rows, seconds)]),
    ),
    delivery_to_entry_latency: latencySummary(deliveryLatencies),
  };
}

function metricDifference(validation, research, key) {
  const left = validation[key];
  const right = research[key];
  return left === null || right === null ? null : rounded(left - right);
}

function createProductReport(
  rows,
  anchorDeliveredTotal,
  runMode,
  malformedOutcomeCount,
  horizonSeconds,
) {
  const splitAt = Math.floor(rows.length * 0.7);
  const research = productSlice(rows.slice(0, splitAt), horizonSeconds);
  const validation = productSlice(rows.slice(splitAt), horizonSeconds);
  const overall = productSlice(rows, horizonSeconds);
  const overall60m = overall.horizons['3600'];
  const validation60m = validation.horizons['3600'];
  const gates = {
    shadow_mode: runMode === 'shadow',
    solidified_anchors_100: rows.length >= 100,
    executable_complete_60m_60: overall60m.executable_complete_rate_wilson_95.numerator >= 60,
    validation_anchors_30: validation.anchors >= 30,
    validation_executable_complete_60m_18:
      validation60m.executable_complete_rate_wilson_95.numerator >= 18,
    outcome_shape_valid: malformedOutcomeCount === 0,
  };
  const stabilityByHorizon = Object.fromEntries(
    horizonSeconds.map((seconds) => {
      const key = String(seconds);
      return [
        key,
        {
          complete_rate: metricDifference(
            validation.horizons[key].complete_rate_wilson_95,
            research.horizons[key].complete_rate_wilson_95,
            'rate',
          ),
          executable_complete_rate: metricDifference(
            validation.horizons[key].executable_complete_rate_wilson_95,
            research.horizons[key].executable_complete_rate_wilson_95,
            'rate',
          ),
          positive_return_rate: metricDifference(
            validation.horizons[key].positive_return_rate_wilson_95,
            research.horizons[key].positive_return_rate_wilson_95,
            'rate',
          ),
          mean_forward_return: metricDifference(
            validation.horizons[key].forward_return,
            research.horizons[key].forward_return,
            'mean',
          ),
        },
      ];
    }),
  );
  return {
    anchor_delivered_total: anchorDeliveredTotal,
    solidified_60m: rows.length,
    pending_60m: Math.max(0, anchorDeliveredTotal - rows.length),
    malformed_or_missing_horizons: malformedOutcomeCount,
    split_rule: 'chronological_first_70_percent_vs_last_30_percent',
    overall,
    research,
    validation,
    stability_validation_minus_research: {
      executable_rate: metricDifference(
        validation.executable_rate_wilson_95,
        research.executable_rate_wilson_95,
        'rate',
      ),
      horizons: stabilityByHorizon,
    },
    gates,
    product_review_ready: Object.values(gates).every(Boolean),
    parameter_policy: Object.values(gates).every(Boolean)
      ? 'manual_review_required'
      : 'frozen_until_sample_gates',
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
const nextCohort = database
  .prepare(
    `SELECT created_at FROM rule_config_versions
     WHERE created_at > ? ORDER BY created_at ASC LIMIT 1`,
  )
  .get(cohort.created_at);
const cohortEnd = nextCohort?.created_at ?? Date.now();
cohort.ended_at = nextCohort?.created_at ?? null;

const runtimeRows = database
  .prepare(
    `SELECT chain, token_address, pool_address, observed_at, payload_encoding, payload
     FROM provider_events
     WHERE provider = 'runtime' AND capability = 'scheduler.decision'
       AND observed_at >= ? AND observed_at < ? ORDER BY observed_at, id`,
  )
  .all(cohort.created_at, cohortEnd)
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
      if (key && /429|credit|rate/u.test(reason)) {
        state.supplierDeferred.add(key);
        const deferredAt = state.supplierDeferralsByKey.get(key) ?? [];
        deferredAt.push(eventTime);
        state.supplierDeferralsByKey.set(key, deferredAt);
      }
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
     WHERE provider = 'coingecko' AND observed_at >= ? AND observed_at < ?
       AND capability IN ('pools.multi.level1', 'trades.level1')
     GROUP BY chain, capability`,
  )
  .all(cohort.created_at, cohortEnd);
for (const row of requestRows) {
  if (row.chain !== 'sol' && row.chain !== 'bsc') continue;
  if (row.capability === 'pools.multi.level1') chains[row.chain].batchCalls = Number(row.calls);
  if (row.capability === 'trades.level1') chains[row.chain].tradeCalls = Number(row.calls);
}

const keyCreditSamples = database
  .prepare(
    `SELECT payload_encoding, payload FROM provider_events
     WHERE provider = 'coingecko' AND capability = 'key'
       AND observed_at >= ? AND observed_at < ?
     ORDER BY observed_at`,
  )
  .all(cohort.created_at, cohortEnd)
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
     WHERE config_version_id = ? AND safety_status = 'pass'
       AND status NOT IN ('expired', 'delivered', 'completed')
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
  const active = ['armed', 'confirmed-pending-anchor'].includes(row.status);
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

const anchorDestination = cohortConfig.delivery?.outcome_anchor_destination;
if (!['admin_private', 'channel', 'group'].includes(anchorDestination))
  throw new Error('Cohort anchor destination is invalid');
const productHorizonSeconds = cohortConfig.outcomes?.horizons_seconds;
if (
  !Array.isArray(productHorizonSeconds) ||
  !productHorizonSeconds.every((value) => Number.isSafeInteger(value) && value > 0) ||
  !productHorizonSeconds.includes(3600)
)
  throw new Error('Cohort product horizons must include 3600 seconds');
const anchorDeliveredRows = database
  .prepare(
    `SELECT c.chain, COUNT(DISTINCT s.id) AS anchors
     FROM delivery_outbox d
     JOIN signals s ON s.id = d.signal_id
     JOIN candidates c ON c.id = s.candidate_id
     WHERE d.destination = ? AND d.message_type = 'ENTRY_SIGNAL'
       AND d.status = 'sent' AND d.delivery_uncertain = 0
       AND d.sent_at IS NOT NULL
       AND s.config_version_id = ? AND c.config_version_id = ?
     GROUP BY c.chain`,
  )
  .all(anchorDestination, cohort.id, cohort.id);
const anchorDeliveredByChain = Object.fromEntries(
  anchorDeliveredRows.map((row) => [row.chain, Number(row.anchors)]),
);
const productRows = database
  .prepare(
    `SELECT o.id, c.chain, o.anchor_delivered_at, o.execution_status,
            o.delivery_to_entry_latency_ms, o.horizon_results_json
     FROM outcomes o
     JOIN signals s ON s.id = o.signal_id
     JOIN candidates c ON c.id = s.candidate_id
     JOIN delivery_outbox d ON d.signal_id = s.id
       AND d.destination = o.anchor_destination AND d.message_type = 'ENTRY_SIGNAL'
     WHERE o.config_version_id = ? AND s.config_version_id = ? AND c.config_version_id = ?
       AND o.anchor_destination = ? AND o.anchor_delivered_at IS NOT NULL
       AND d.status = 'sent' AND d.delivery_uncertain = 0 AND d.sent_at = o.anchor_delivered_at
     ORDER BY c.chain, o.anchor_delivered_at, o.id`,
  )
  .all(cohort.id, cohort.id, cohort.id, anchorDestination);
const productByChain = { sol: [], bsc: [] };
const malformedProductRows = { sol: 0, bsc: 0 };
for (const row of productRows) {
  if (row.chain !== 'sol' && row.chain !== 'bsc') continue;
  const horizons = parseJson(row.horizon_results_json);
  const parsedHorizons = {};
  const horizonKeys = Array.isArray(horizons)
    ? horizons.map((value) => Number(record(value).horizonSeconds))
    : [];
  let valid =
    Array.isArray(horizons) &&
    horizons.length === productHorizonSeconds.length &&
    new Set(horizonKeys).size === horizonKeys.length &&
    productHorizonSeconds.every((seconds) => horizonKeys.includes(seconds)) &&
    Number.isSafeInteger(Number(row.anchor_delivered_at));
  for (const seconds of productHorizonSeconds) {
    const parsedHorizon = record(
      Array.isArray(horizons)
        ? horizons.find((value) => Number(record(value).horizonSeconds) === seconds)
        : undefined,
    );
    const status = parsedHorizon.status;
    const forwardReturn = finiteMetric(parsedHorizon.forwardReturn);
    const mfe = finiteMetric(parsedHorizon.mfe);
    const mae = finiteMetric(parsedHorizon.mae);
    const completeMetricsValid =
      status !== 'complete' ||
      (forwardReturn !== undefined && mfe !== undefined && mae !== undefined);
    if (!['complete', 'late_entry', 'incomplete'].includes(status) || !completeMetricsValid) {
      valid = false;
      break;
    }
    parsedHorizons[String(seconds)] = {
      status,
      ...(status === 'complete' ? { forwardReturn, mfe, mae } : {}),
    };
  }
  if (!valid) {
    malformedProductRows[row.chain] += 1;
    continue;
  }
  productByChain[row.chain].push({
    anchorDeliveredAt: Number(row.anchor_delivered_at),
    executionStatus: row.execution_status,
    ...(finiteMetric(row.delivery_to_entry_latency_ms) === undefined
      ? {}
      : { deliveryLatencyMs: Number(row.delivery_to_entry_latency_ms) }),
    horizons: parsedHorizons,
  });
}

const chainReports = {};
for (const chain of ['sol', 'bsc']) {
  const state = chains[chain];
  const totalRateLimited429 = state.rateLimited429 + globalRateLimited429;
  const cleanBatchLatencies = [...state.batchCandidates.entries()]
    .filter(([key, value]) =>
      (state.supplierDeferralsByKey.get(key) ?? []).every(
        (deferredAt) => deferredAt < value.dueAt || deferredAt > value.completedAt,
      ),
    )
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
    product_review: createProductReport(
      productByChain[chain],
      anchorDeliveredByChain[chain] ?? 0,
      cohort.run_mode,
      malformedProductRows[chain],
      productHorizonSeconds,
    ),
    gates,
    engineering_ready: Object.values(gates).every(Boolean),
  };
}

const engineeringReady = Object.values(chainReports).every((report) => report.engineering_ready);
const productReviewReady = Object.values(chainReports).every(
  (report) => report.product_review.product_review_ready,
);
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
  product_review_ready: productReviewReady,
  recommendation:
    engineeringReady && productReviewReady ? 'manual_product_review_required' : 'hold_shadow',
};

console.log(JSON.stringify(result, null, 2));
database.close();

function createChainState() {
  return {
    batchCandidates: new Map(),
    batchAttempts: 0,
    supplierDeferred: new Set(),
    supplierDeferralsByKey: new Map(),
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
