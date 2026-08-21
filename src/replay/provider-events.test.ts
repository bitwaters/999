import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractReplayProviderEvent } from './provider-events.js';

test('replay extraction keeps the matching GMGN token raw safety beside discovery', () => {
  const result = extractReplayProviderEvent(
    {
      provider: 'gmgn',
      capability: 'market.trending.1m',
      chain: 'bsc',
      observed_at: 1_000,
    },
    {
      data: {
        rank: [
          { address: '0xABC', is_honeypot: false },
          { address: '0xDEF', is_honeypot: true },
        ],
      },
    },
  );
  assert.deepEqual(
    result.discovery.map((item) => [item.tokenAddress, item.rank]),
    [
      ['0xabc', 1],
      ['0xdef', 2],
    ],
  );
  assert.equal((result.evidence[0]!.payload as { is_honeypot: boolean }).is_honeypot, false);
});

test('replay extraction isolates malformed provider token addresses', () => {
  const extracted = extractReplayProviderEvent(
    {
      provider: 'gmgn',
      capability: 'market.trending.1m',
      chain: 'bsc',
      observed_at: 1_000,
    },
    {
      data: {
        rank: [
          { address: ' 0xinvalid ' },
          { address: '0xABC', renounced: true },
        ],
      },
    },
  );
  assert.deepEqual(extracted.discovery.map((item) => item.tokenAddress), ['0xabc']);
  assert.deepEqual(extracted.evidence.map((item) => item.tokenAddress), ['0xabc']);
});

test('replay extraction includes targeted GMGN token security refreshes', () => {
  const payload = { address: '0xABC', is_honeypot: false };
  const result = extractReplayProviderEvent(
    {
      provider: 'gmgn',
      capability: 'token.security',
      chain: 'bsc',
      token_address: '0xABC',
      observed_at: 1_500,
    },
    payload,
  );
  assert.deepEqual(result.discovery, []);
  assert.deepEqual(result.evidence, [
    {
      kind: 'safety',
      chain: 'bsc',
      tokenAddress: '0xabc',
      observedAt: 1_500,
      payload,
    },
  ]);
});

test('replay extraction distinguishes token pool, Level 1, G2, trades and OHLCV raw events', () => {
  const capabilities = [
    ['tokens.multi', 'pool'],
    ['pools.multi.level1', 'level1'],
    ['G2', 'g2'],
    ['trades.level1', 'trades'],
    ['ohlcv.30s', 'ohlcv'],
  ] as const;
  for (const [capability, kind] of capabilities) {
    const result = extractReplayProviderEvent(
      {
        provider: 'coingecko',
        capability,
        chain: 'sol',
        token_address: 'token',
        pool_address: 'pool',
        observed_at: 2_000,
      },
      { raw: true },
    );
    assert.equal(result.evidence[0]?.kind, kind);
  }
});
