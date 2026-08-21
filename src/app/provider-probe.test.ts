import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  g2ProbeState,
  latestLevel1ObservedAt,
  shouldRearmG2Candidate,
} from './provider-probe.js';

test('Level 1 evidence observedAt covers the later pool and trades responses', () => {
  assert.equal(latestLevel1ObservedAt(1_000, 1_250), 1_250);
  assert.equal(latestLevel1ObservedAt(1_250, 1_000), 1_250);
  assert.throws(() => latestLevel1ObservedAt(1_000, -1), /Invalid Level 1 evidence timestamp/);
});

test('G2 is healthy when no candidate currently requires an active socket', () => {
  assert.equal(g2ProbeState(undefined, false), 'ok');
  assert.equal(g2ProbeState('unknown', false), 'unknown');
  assert.equal(g2ProbeState('failed', false), 'failed');
  assert.equal(g2ProbeState(undefined, true), 'failed');
});

test('G2 re-arms persisted candidates after a process restart', () => {
  assert.equal(shouldRearmG2Candidate('armed', 'armed'), true);
  assert.equal(shouldRearmG2Candidate('scouting', 'level1_checked'), true);
  assert.equal(shouldRearmG2Candidate('scouting', 'armed'), false);
  assert.equal(shouldRearmG2Candidate('expired', 'armed'), false);
});
