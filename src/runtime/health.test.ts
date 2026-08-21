import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHealthSnapshot, conservativeDegradation, createStructuredLogger } from './health.js';

const snapshot = buildHealthSnapshot({
  commit: 'commit',
  configHash: 'hash',
  schemaVersion: 1,
  clockOffsetMs: 0,
  components: {
    provider: 'ok',
    safety: 'ok',
    level1: 'ok',
    g2: 'ok',
    telegram: 'ok',
    sqlite: 'ok',
  },
  disk: { freeBytes: 100, usedPercent: 10, highWater: false },
  generatedAt: 1,
});

test('health snapshot and degradation fail closed on disk or provider faults', () => {
  assert.equal(snapshot.status, 'healthy');
  const degraded = buildHealthSnapshot({
    ...snapshot,
    components: { ...snapshot.components, g2: 'unknown' },
    disk: { ...snapshot.disk, highWater: true },
  });
  assert.equal(degraded.status, 'failed');
  const decision = conservativeDegradation(degraded);
  assert.equal(decision.allowSignal, false);
  assert.equal(decision.allowOutbox, false);
  assert.equal(decision.allowOutcome, false);
  assert.ok(decision.reasons.includes('disk:high_water'));
});

test('structured logs redact secret-shaped fields', () => {
  const lines: string[] = [];
  createStructuredLogger((line) => lines.push(line))('error', 'health_failed', {
    api_key: 'secret',
    nested: { authorization: 'bearer secret', safe: 'ok' },
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.includes('secret'), false);
  assert.equal(lines[0]!.includes('"safe":"ok"'), true);
});
