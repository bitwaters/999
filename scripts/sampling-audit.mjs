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
  SELECT chain, COUNT(*) AS attempts, SUM(indexed) AS indexed_count,
         ROUND(100.0 * SUM(indexed) / COUNT(*), 2) AS indexed_rate_percent,
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
const hasInsufficientIndexingCoverage =
  indexing.length === 0 ||
  indexing.some(
    (row) => row.indexed_rate_percent === null || Number(row.indexed_rate_percent) < 95,
  );
const result = {
  database: databasePath,
  sampleRange,
  provider,
  indexing,
  websocket,
  credits,
  productionRecommendation:
    providerCallCount === 0 ||
    hasProviderFailures ||
    hasInsufficientIndexingCoverage ||
    creditSampleCount < 10
      ? 'hold_shadow'
      : 'requires_manual_review',
};
console.log(JSON.stringify(result, null, 2));
database.close();
