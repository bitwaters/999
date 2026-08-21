import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyIndexingResult,
  discoveryCategory,
  retryDelaySeconds,
  selectIndexingCandidates,
} from './sampling-scheduler.mjs';

const config = JSON.parse(
  await readFile(new URL('../config/preflight-sampling.json', import.meta.url), 'utf8'),
);

test('sampling retains unresolved candidates across multiple retry windows', () => {
  const pendingSeconds = config.coingecko.pending_ttl_minutes * 60;
  const maxRetrySeconds = config.coingecko.index_retry_max_seconds;

  assert.ok(pendingSeconds >= 2 * maxRetrySeconds);
  assert.ok(config.coingecko.pending_ttl_minutes >= 120);
});

test('sampling gives primary discovery candidates a reserved first claim on each chain quota', () => {
  const selected = selectIndexingCandidates(
    [
      {
        token_address: 'aux-old',
        source_category: 'auxiliary',
        first_seen_at: 1,
        next_retry_at: null,
        resolved: false,
      },
      {
        token_address: 'primary-new',
        source_category: 'primary',
        first_seen_at: 10,
        next_retry_at: null,
        resolved: false,
      },
      {
        token_address: 'primary-due',
        source_category: 'primary',
        first_seen_at: 20,
        next_retry_at: 50,
        resolved: false,
      },
      {
        token_address: 'not-due',
        source_category: 'primary',
        first_seen_at: 0,
        next_retry_at: 200,
        resolved: false,
      },
    ],
    { now: 100, cutoff: 0, limit: 2 },
  );

  assert.deepEqual(
    selected.map((candidate) => candidate.token_address),
    ['primary-new', 'primary-due'],
  );
});

test('sampling fills unused primary quota with due auxiliary candidates without pre-limit starvation', () => {
  const selected = selectIndexingCandidates(
    [
      ...Array.from({ length: 1000 }, (_, index) => ({
        token_address: `aux-${index}`,
        source_category: 'auxiliary',
        first_seen_at: index,
        next_retry_at: null,
        resolved: false,
      })),
      {
        token_address: 'primary',
        source_category: 'primary',
        first_seen_at: 10_000,
        next_retry_at: null,
        resolved: false,
      },
    ],
    { now: 100, cutoff: 0, limit: 3 },
  );

  assert.deepEqual(
    selected.map((candidate) => candidate.token_address),
    ['primary', 'aux-0', 'aux-1'],
  );
});

test('sampling keeps retry backoff deterministic and classifies unresolved provider shapes', () => {
  assert.equal(retryDelaySeconds(1, 60, 600), 60);
  assert.equal(retryDelaySeconds(4, 60, 600), 480);
  assert.equal(retryDelaySeconds(5, 60, 600), 600);
  assert.equal(discoveryCategory('trending'), 'primary');
  assert.equal(discoveryCategory('trenches'), 'auxiliary');
  assert.equal(classifyIndexingResult({ token: null }), 'token_absent');
  assert.equal(
    classifyIndexingResult({ token: {}, relationships: {}, topPoolRows: [] }),
    'pool_relationship_missing',
  );
  assert.equal(
    classifyIndexingResult({ token: {}, relationships: { top_pools: {} }, topPoolRows: [] }),
    'token_present_no_top_pool',
  );
  assert.equal(
    classifyIndexingResult({
      token: {},
      relationships: { top_pools: {} },
      topPoolRows: [{ id: 'bsc_pool' }],
      pool: null,
    }),
    'included_pool_missing',
  );
});
