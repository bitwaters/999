import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestLevel1ObservedAt } from './provider-probe.js';

test('Level 1 evidence observedAt covers the later pool and trades responses', () => {
  assert.equal(latestLevel1ObservedAt(1_000, 1_250), 1_250);
  assert.equal(latestLevel1ObservedAt(1_250, 1_000), 1_250);
  assert.throws(() => latestLevel1ObservedAt(1_000, -1), /Invalid Level 1 evidence timestamp/);
});
