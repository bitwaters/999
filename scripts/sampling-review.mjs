#!/usr/bin/env node

import { access, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const databasePath = process.argv[2] || path.join(root, 'sampling-data', 'sampling.sqlite');
const configPath = process.argv[3] || path.join(root, 'config', 'bot.yaml');

await access(databasePath);
await access(configPath);

const database = new DatabaseSync(databasePath, { readOnly: true });
const config = parseYaml(await readFile(configPath, 'utf8'));
const all = (sql, ...params) => database.prepare(sql).all(...params);
const one = (sql, ...params) => database.prepare(sql).get(...params);

const sampleRange = one(`
  SELECT MIN(observed_at) AS first_observed_at,
         MAX(observed_at) AS last_observed_at,
         COUNT(*) AS provider_call_count
  FROM provider_calls
`);
const firstObservedAt = Number(sampleRange?.first_observed_at ?? 0);
const lastObservedAt = Number(sampleRange?.last_observed_at ?? 0);
const sampleDurationMs = Math.max(0, lastObservedAt - firstObservedAt);
const recentWindowMs = Math.min(5 * 60 * 1000, sampleDurationMs || 5 * 60 * 1000);
const recentCutoff = Math.max(firstObservedAt, lastObservedAt - recentWindowMs);

const provider = all(`
  SELECT provider, COUNT(*) AS calls, SUM(ok = 0) AS failures,
         ROUND(100.0 * SUM(ok = 0) / COUNT(*), 2) AS failure_rate_percent,
         ROUND(AVG(latency_ms), 1) AS avg_latency_ms,
         MAX(latency_ms) AS max_latency_ms
  FROM provider_calls
  GROUP BY provider
  ORDER BY provider
`);
const recentProvider = all(
  `
  SELECT provider, COUNT(*) AS calls, SUM(ok = 0) AS failures,
         ROUND(100.0 * SUM(ok = 0) / COUNT(*), 2) AS failure_rate_percent
  FROM provider_calls
  WHERE observed_at >= ?
  GROUP BY provider
  ORDER BY provider
`,
  recentCutoff,
);
const indexing = all(`
  SELECT chain, COUNT(*) AS attempts, COUNT(DISTINCT token_address) AS unique_tokens,
         SUM(indexed) AS indexed_attempts,
         COUNT(DISTINCT CASE WHEN indexed = 1 THEN token_address END) AS indexed_tokens,
         ROUND(100.0 * SUM(indexed) / COUNT(*), 2) AS attempt_indexed_rate_percent,
         ROUND(100.0 * COUNT(DISTINCT CASE WHEN indexed = 1 THEN token_address END)
               / COUNT(DISTINCT token_address), 2) AS unique_indexed_rate_percent,
         ROUND(AVG(indexing_latency_seconds), 1) AS avg_indexing_latency_seconds,
         MAX(indexing_latency_seconds) AS max_indexing_latency_seconds
  FROM indexing_attempts
  GROUP BY chain
  ORDER BY chain
`);
const recentIndexing = all(
  `
  SELECT chain, COUNT(*) AS attempts, SUM(indexed) AS indexed_count,
         COUNT(DISTINCT token_address) AS unique_tokens,
         COUNT(DISTINCT CASE WHEN indexed = 1 THEN token_address END) AS indexed_tokens,
         ROUND(100.0 * SUM(indexed) / COUNT(*), 2) AS attempt_indexed_rate_percent,
         ROUND(100.0 * COUNT(DISTINCT CASE WHEN indexed = 1 THEN token_address END)
               / COUNT(DISTINCT token_address), 2) AS unique_indexed_rate_percent
  FROM indexing_attempts
  WHERE attempted_at >= ?
  GROUP BY chain
  ORDER BY chain
`,
  recentCutoff,
);
const discoverySourceCoverage = all(`
  SELECT c.chain, c.source,
         COUNT(DISTINCT c.token_address) AS candidate_tokens,
         COUNT(DISTINCT CASE WHEN p.token_address IS NOT NULL THEN c.token_address END)
           AS indexed_tokens
  FROM candidate_observations c
  LEFT JOIN token_pools p ON p.chain = c.chain AND p.token_address = c.token_address
  GROUP BY c.chain, c.source
  ORDER BY c.chain, c.source
`);
const productionDiscoverySources = ['trending', 'hot-searches'];
const productionDiscoveryCoverage = all(
  `
  SELECT c.chain,
         COUNT(DISTINCT c.token_address) AS candidate_tokens,
         COUNT(DISTINCT CASE WHEN p.token_address IS NOT NULL THEN c.token_address END)
           AS indexed_tokens,
         ROUND(100.0 * COUNT(DISTINCT CASE WHEN p.token_address IS NOT NULL THEN c.token_address END)
               / COUNT(DISTINCT c.token_address), 2) AS indexed_rate_percent
  FROM candidate_observations c
  LEFT JOIN token_pools p ON p.chain = c.chain AND p.token_address = c.token_address
  WHERE c.source IN (?, ?)
  GROUP BY c.chain
  ORDER BY c.chain
`,
  ...productionDiscoverySources,
);
const credits = all(`
  SELECT observed_at, plan, rpm, monthly_credit, used_credit, remaining_credit
  FROM credit_samples
  ORDER BY observed_at
`);
const latestCredits = credits.at(-1) || null;
const websocketEvents = one('SELECT COUNT(*) AS events FROM websocket_events');
const outcomeTables = all(
  "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%outcome%'",
);

const s1Policies = Object.entries(config.chains || {}).map(([chain, chainConfig]) => {
  const policies = Object.entries(chainConfig.safety?.s1 || {}).map(([name, policy]) => ({
    name,
    enabled: Boolean(policy.enabled),
    verified: Boolean(policy.verified),
    max: policy.max,
  }));
  return {
    chain,
    policies,
    enabled: policies.filter((policy) => policy.enabled),
    enabledUnverified: policies.filter((policy) => policy.enabled && !policy.verified),
  };
});
const allS1Disabled = s1Policies.every((chain) => chain.enabled.length === 0);

const providerCallCount = Number(sampleRange?.provider_call_count ?? 0);
const observedMinutes = sampleDurationMs / 60_000;
const observedCallsPerMinute = observedMinutes > 0 ? providerCallCount / observedMinutes : null;
const hasProviderFailures = provider.some((row) => Number(row.failures ?? 0) > 0);
const hasInsufficientProductionDiscovery =
  productionDiscoveryCoverage.length === 0 ||
  productionDiscoveryCoverage.some(
    (row) => row.indexed_rate_percent === null || Number(row.indexed_rate_percent) < 95,
  );
const outcomeEvidence = outcomeTables.length
  ? { available: true, tables: outcomeTables.map((row) => row.name) }
  : {
      available: false,
      reason:
        'sampling database contains raw-ingestion evidence only; no outcome labels or evaluation rows',
    };
const parameterSensitivity = outcomeEvidence.available
  ? {
      status: 'requires_manual_review',
      reason: 'labels exist but sensitivity execution is not part of this read-only audit',
    }
  : {
      status: 'not_estimable',
      reason: 'no outcome labels are available in the accumulated sampling database',
    };
const budgetSimulation = latestCredits
  ? {
      status: 'requires_manual_review',
      observed_calls_per_minute: Number(observedCallsPerMinute?.toFixed(3) ?? 0),
      latest_remaining_credit: latestCredits.remaining_credit,
      latest_rpm: latestCredits.rpm,
      credit_sample_count: credits.length,
      reason:
        'short sample and provider-specific costs are insufficient for a production budget forecast',
    }
  : {
      status: 'not_estimable',
      reason: 'no credit samples are available',
    };

const result = {
  database: databasePath,
  sampleRange: {
    ...sampleRange,
    duration_ms: sampleDurationMs,
    provider_calls_per_minute: Number(observedCallsPerMinute?.toFixed(3) ?? 0),
  },
  recentValidationSlice: {
    cutoff: recentCutoff,
    window_ms: recentWindowMs,
    provider: recentProvider,
    indexing: recentIndexing,
  },
  provider,
  indexing,
  discoverySourceCoverage,
  productionDiscoveryCoverage: {
    sources: productionDiscoverySources,
    chains: productionDiscoveryCoverage,
  },
  websocket_events: Number(websocketEvents?.events ?? 0),
  credits: {
    samples: credits.length,
    latest: latestCredits,
  },
  outcomeEvidence,
  parameterSensitivity,
  budgetSimulation,
  s1PolicyReview: {
    all_s1_disabled: allS1Disabled,
    policies: s1Policies,
    recommendation: allS1Disabled
      ? 'keep_s1_disabled_until_field_direction_unit_and_real_fixture_review'
      : 'hold_shadow_until_enabled_s1_is_verified',
  },
  productionRecommendation:
    providerCallCount === 0 ||
    hasProviderFailures ||
    hasInsufficientProductionDiscovery ||
    credits.length < 10 ||
    !outcomeEvidence.available ||
    parameterSensitivity.status === 'not_estimable'
      ? 'hold_shadow'
      : 'requires_manual_review',
};

console.log(JSON.stringify(result, null, 2));
database.close();
