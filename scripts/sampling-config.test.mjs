import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const config = JSON.parse(
  await readFile(new URL('../config/preflight-sampling.json', import.meta.url), 'utf8'),
);

test('sampling retains unresolved candidates across multiple retry windows', () => {
  const pendingSeconds = config.coingecko.pending_ttl_minutes * 60;
  const maxRetrySeconds = config.coingecko.index_retry_max_seconds;

  assert.ok(pendingSeconds >= 2 * maxRetrySeconds);
  assert.ok(config.coingecko.pending_ttl_minutes >= 120);
});
