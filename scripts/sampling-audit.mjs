#!/usr/bin/env node

import { access } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const databasePath = process.argv[2] || path.join(root, 'sampling-data', 'sampling.sqlite');
await access(databasePath);
const database = new DatabaseSync(databasePath, { readOnly: true });
const all = (sql) => database.prepare(sql).all();
const one = (sql) => database.prepare(sql).get();

const provider = all(`
  SELECT provider, COUNT(*) AS calls, SUM(ok = 0) AS failures,
         ROUND(AVG(latency_ms), 1) AS avg_latency_ms, MAX(latency_ms) AS max_latency_ms
  FROM provider_calls GROUP BY provider ORDER BY provider
`);
const indexing = all(`
  SELECT chain, COUNT(*) AS attempts, COUNT(DISTINCT token_address) AS unique_tokens,
         SUM(indexed) AS indexed_attempts,
         COUNT(DISTINCT CASE WHEN indexed = 1 THEN token_address END) AS indexed_tokens,
         ROUND(100.0 * SUM(indexed) / COUNT(*), 2) AS attempt_indexed_rate_percent,
         ROUND(100.0 * COUNT(DISTINCT CASE WHEN indexed = 1 THEN token_address END)
               / COUNT(DISTINCT token_address), 2) AS unique_indexed_rate_percent,
         ROUND(AVG(indexing_latency_seconds), 1) AS avg_indexing_latency_seconds,
         MAX(indexing_latency_seconds) AS max_indexing_latency_seconds
  FROM indexing_attempts GROUP BY chain ORDER BY chain
`);
const websocket = all(`
  SELECT channel, chain, COUNT(*) AS events,
         MIN(observed_at) AS first_observed_at, MAX(observed_at) AS last_observed_at
  FROM websocket_events GROUP BY channel, chain ORDER BY channel, chain
`);
const credits = one(`
  SELECT COUNT(*) AS samples, MIN(remaining_credit) AS min_remaining_credit,
         MAX(rpm) AS max_rpm FROM credit_samples
`);
const sampleRange = one(`
  SELECT MIN(observed_at) AS first_observed_at, MAX(observed_at) AS last_observed_at,
         COUNT(*) AS provider_call_count FROM provider_calls
`);
const providerCallCount = Number(sampleRange?.provider_call_count ?? 0);
const creditSampleCount = Number(credits?.samples ?? 0);
const hasProviderFailures = provider.some((row) => Number(row.failures ?? 0) > 0);
const productionDiscoveryCoverage = all(`
  SELECT s.chain,
         COUNT(*) AS candidate_tokens,
         COUNT(CASE WHEN s.last_indexing_at IS NOT NULL THEN 1 END) AS attempted_tokens,
         COUNT(CASE WHEN s.last_indexing_at IS NULL THEN 1 END) AS not_attempted_tokens,
         COUNT(CASE WHEN p.token_address IS NOT NULL THEN 1 END) AS indexed_tokens,
         ROUND(100.0 * COUNT(CASE WHEN s.last_indexing_at IS NOT NULL THEN 1 END)
               / COUNT(*), 2) AS scheduling_coverage_percent,
         ROUND(100.0 * COUNT(CASE WHEN p.token_address IS NOT NULL THEN 1 END)
               / NULLIF(COUNT(CASE WHEN s.last_indexing_at IS NOT NULL THEN 1 END), 0), 2)
           AS indexed_rate_of_attempted_percent
  FROM sampling_candidates s
  LEFT JOIN token_pools p ON p.chain = s.chain AND p.token_address = s.token_address
  WHERE s.primary_seen_at IS NOT NULL
  GROUP BY s.chain
  ORDER BY s.chain
`);
const indexingResolutionReasons = all(`
  SELECT chain, COALESCE(source_category, 'unknown') AS source_category,
         COALESCE(resolution_reason, CASE WHEN indexed = 1 THEN 'resolved' ELSE 'legacy_unclassified' END)
           AS resolution_reason,
         COUNT(*) AS attempts, COUNT(DISTINCT token_address) AS unique_tokens
  FROM indexing_attempts
  GROUP BY chain, source_category, resolution_reason
  ORDER BY chain, source_category, resolution_reason
`);
const result = {
  database: databasePath,
  sampleRange,
  provider,
  indexing,
  productionDiscoveryCoverage,
  indexingResolutionReasons,
  websocket,
  credits,
  productionRecommendation:
    providerCallCount === 0 || hasProviderFailures || creditSampleCount < 10
      ? 'hold_shadow'
      : 'requires_manual_review',
};
console.log(JSON.stringify(result, null, 2));
database.close();
