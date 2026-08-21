import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertAnalystEndpoint } from './http.js';
import { classifyWindow, parseDecimalString, parseInteger, parseTimestampMs } from './parsing.js';
import {
  coingeckoG2RawSchema,
  coingeckoOhlcv30sRawSchema,
  gmgnHotSearchesRawSchema,
  gmgnSecurityRawSchema,
  gmgnTrendingRawSchema,
} from './raw-schemas.js';
import { CreditMeter, WeightedRequestQueue } from './queue.js';

test('parses independent GMGN capability shapes without coercing types', () => {
  assert.equal(
    gmgnTrendingRawSchema.parse({
      code: 0,
      data: { rank: [{ address: 'token', renounced_mint: true }] },
    }).data.rank.length,
    1,
  );
  assert.equal(
    gmgnHotSearchesRawSchema.parse([
      { chain: 'sol', tokens: [{ address: 'token', visiting_count: 2 }] },
    ])[0]!.chain,
    'sol',
  );
  assert.throws(() => gmgnTrendingRawSchema.parse({ code: 0, data: { rank: {} } }), /array/u);
  assert.equal(
    gmgnSecurityRawSchema.parse({
      address: 'token',
      renounced_mint: true,
      renounced_freeze_account: true,
    }).renounced_mint,
    true,
  );
  assert.equal(
    gmgnSecurityRawSchema.parse({
      address: '0xtoken',
      is_honeypot: false,
      is_renounced: true,
      is_open_source: true,
      buy_tax: '0.01',
      sell_tax: '0.02',
    }).is_renounced,
    true,
  );
  assert.throws(() => gmgnSecurityRawSchema.parse([]));
  assert.throws(() => gmgnSecurityRawSchema.parse({ code: 0, data: { renounced_mint: true } }));
});

test('validates G2 and 30-second OHLCV raw fixtures', () => {
  assert.equal(
    coingeckoG2RawSchema.parse({ c: 'G2', n: 'solana', pa: 'pool', ty: 'buy', t: 1000 }).c,
    'G2',
  );
  assert.equal(
    coingeckoOhlcv30sRawSchema.parse({ data: [[1000, '1', '2', '0.5', '1.5', '10']] }).data[0]![1],
    '1',
  );
});

test('rejects public GeckoTerminal endpoints', () => {
  assert.doesNotThrow(() =>
    assertAnalystEndpoint(
      'https://pro-api.coingecko.com/api/v3/onchain/networks/solana/pools',
      'https://pro-api.coingecko.com/api/v3',
    ),
  );
  assert.throws(
    () =>
      assertAnalystEndpoint(
        'https://api.geckoterminal.com/api/v2/networks/solana/pools',
        'https://pro-api.coingecko.com/api/v3',
      ),
    /Analyst endpoint/u,
  );
});

test('parses financial strings exactly and classifies conservative DataState', () => {
  assert.equal(parseDecimalString('0.100000', { maxScale: 6 }).toFixed(), '0.1');
  assert.throws(() => parseDecimalString('1e-8'), /Invalid decimal/u);
  assert.throws(() => parseDecimalString('-1', { nonNegative: true }), /non-negative/u);
  assert.equal(parseInteger(3, { min: 0 }), 3);
  assert.equal(parseTimestampMs(1000), 1000);
  assert.equal(
    classifyWindow({
      present: true,
      valid: true,
      coverageSeconds: 30,
      requiredSeconds: 300,
      count: 4,
    }),
    'partial',
  );
  assert.equal(classifyWindow({ present: true, valid: true, count: 0 }), 'zero');
  assert.equal(classifyWindow({ present: true, valid: false }), 'invalid');
});

test('queues weighted work and blocks credits without assuming one message equals one credit', async () => {
  const queue = new WeightedRequestQueue(0);
  const result = await Promise.all([
    queue.enqueue(async () => 'discovery', { weight: 1, priority: 1 }),
    queue.enqueue(async () => 'safety', { weight: 2, priority: 2 }),
  ]);
  assert.deepEqual(result, ['discovery', 'safety']);
  const meter = new CreditMeter();
  meter.record({
    observedAt: 1,
    remainingCredits: 100,
    remainingMonthSeconds: 10,
    creditsPerMessageUpperBound: 5,
  });
  assert.equal(meter.allowedMessagesPerSecond(), 2);
  meter.recordMessageCost(10);
  meter.recordMessageCost(20);
  assert.equal(meter.rollingCreditsPerMessage(5), 15);
  assert.equal(meter.allowedMessagesPerSecond(), 2 / 3);
  assert.equal(meter.shouldPause('shadow', 100, 1), false);
  assert.equal(meter.shouldPause('production', 2, 1), true);
});
