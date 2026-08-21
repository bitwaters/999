import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfigText } from '../config/load.js';
import { classifyAge, evaluateAge, type WindowStats } from './age.js';

const template = await readFile(new URL('../../config/bot.yaml', import.meta.url), 'utf8');
const config = parseConfigText(template).config.chains.sol;
const newbornStats: WindowStats = {
  state: 'partial',
  coverageSeconds: 60,
  buys: 3,
  buyers: 3,
  volumeUsd: '1000',
};

test('Newborn accepts partial m1 evidence and uses actual coverage rates', () => {
  const result = evaluateAge(
    0,
    60_000,
    config,
    5,
    { m1: newbornStats, m5: { ...newbornStats, state: 'partial' } },
    30,
  );
  assert.equal(result.status, 'pass');
  if (result.status === 'pass') {
    assert.equal(result.mode, 'newborn');
    assert.equal(result.coverageSeconds, 60);
    assert.equal(result.rates.buys, '0.05');
  }
});

test('Established requires complete configured windows and rejects future pool time', () => {
  const established = evaluateAge(
    0,
    300_000,
    config,
    5,
    {
      m5: { ...newbornStats, state: 'complete' },
      m15: { ...newbornStats, state: 'complete' },
      m30: { ...newbornStats, state: 'partial' },
    },
    60,
  );
  assert.equal(established.status, 'incomplete');
  const future = classifyAge(100_000, 0, config, 5);
  assert.deepEqual(future, { status: 'invalid', reason: 'invalid:future_pool_created_at' });
});

test('Early accepts partial m5 but not missing or invalid values', () => {
  const early = evaluateAge(120_000, 240_000, config, 5, { m5: newbornStats }, 30);
  assert.equal(early.status, 'pass');
  const missing = evaluateAge(120_000, 240_000, config, 5, {}, 30);
  assert.equal(missing.status, 'incomplete');
  const invalid = evaluateAge(
    120_000,
    240_000,
    config,
    5,
    { m1: { ...newbornStats, volumeUsd: 'not-decimal' } },
    30,
  );
  assert.equal(invalid.status, 'incomplete');
});
