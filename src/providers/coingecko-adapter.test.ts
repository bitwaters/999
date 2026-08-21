import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePool, selectPrimaryPool } from '../market-data/pools.js';
import {
  latestTradeAt,
  level1RawForPool,
  level1ScreeningRawForPool,
  poolRawForAddress,
  poolRawsForToken,
  tokenAddressFromCoinGeckoItem,
} from './coingecko-adapter.js';

const token = 'Token111';
const pool = 'Pool111';

const response = {
  data: [
    {
      id: `solana_${token}`,
      type: 'token',
      attributes: { address: token },
      relationships: {
        top_pools: { data: [{ id: `solana_${pool}`, type: 'pool' }] },
      },
    },
  ],
  included: [
    {
      id: `solana_${pool}`,
      type: 'pool',
      attributes: {
        address: pool,
        reserve_in_usd: '1000.50',
        pool_created_at: '2026-08-21T00:00:00Z',
        volume_usd: { h24: '250.25' },
        transactions: { h24: { buys: 4, sells: 3 } },
      },
      relationships: {
        base_token: { data: { id: `solana_${token}`, type: 'token' } },
        quote_token: { data: { id: 'solana_USDC', type: 'token' } },
      },
    },
  ],
};

test('maps Analyst token batches to identity-checked canonical pool candidates', () => {
  assert.equal(tokenAddressFromCoinGeckoItem(response.data[0]!), token);
  const raws = poolRawsForToken(response, 'solana', token);
  assert.equal(raws.length, 1);
  const parsed = parsePool(raws[0]!, 'sol', token);
  assert.equal(parsed.status, 'complete');
  if (parsed.status === 'complete') {
    assert.equal(parsed.pool.poolAddress, pool);
    assert.equal(parsed.pool.targetSide, 'base');
    assert.equal(parsed.pool.trades24h, 7);
    assert.equal(parsed.pool.restSupported, true);
    assert.equal(parsed.pool.g2Supported, true);
    assert.equal(selectPrimaryPool([parsed.pool]).status, 'resolved');
  }
});

test('ignores included pools that are not listed in the token top-pools relationship', () => {
  const result = poolRawsForToken(
    {
      ...response,
      included: [...response.included, { ...response.included[0], id: 'solana_other' }],
    },
    'solana',
    token,
  );
  assert.equal(result.length, 1);
});

test('maps pool snapshots and trades to a fresh Level 1 raw record', () => {
  const raw = poolRawForAddress(
    {
      data: [
        {
          type: 'pool',
          attributes: {
            address: pool,
            reserve_in_usd: '1000.50',
            pool_created_at: '2026-08-21T00:00:00Z',
            transactions: { m5: { buys: 4, sells: 3, buyers: 5, sellers: 4 } },
            volume_usd: { m5: '250.25' },
            net_buy_volume_usd: { m5: '12.25' },
            base_token_price_usd: '1.25',
          },
          relationships: {
            base_token: { data: { id: `solana_${token}` } },
            quote_token: { data: { id: 'solana_USDC' } },
          },
        },
      ],
    },
    'solana',
    pool,
    token,
  );
  assert.ok(raw);
  const parsedPool = parsePool(raw!, 'sol', token);
  assert.equal(parsedPool.status, 'complete');
  if (parsedPool.status !== 'complete') return;
  const observedAt = Date.parse('2026-08-21T00:05:00Z');
  const latest = latestTradeAt({
    data: [
      { attributes: { block_timestamp: '2026-08-21T00:04:59Z' } },
      { attributes: { block_timestamp: '2026-08-21T00:05:01Z' } },
    ],
  });
  const level1 = level1RawForPool(
    raw!,
    parsedPool.pool,
    {
      transactions: { m5: { buys: 4, sells: 3, buyers: 5, sellers: 4 } },
      volume_usd: { m5: '250.25' },
      net_buy_volume_usd: { m5: '12.25' },
      base_token_price_usd: '1.25',
    },
    observedAt,
    latest,
  );
  assert.equal(level1.last_trade_at, Date.parse('2026-08-21T00:05:01Z'));
  assert.equal(level1.buyers, 5);
  assert.equal(level1.net_buy_usd, '12.25');
  assert.deepEqual((level1.windows as Record<string, unknown>).m5, {
    state: 'complete',
    coverage_seconds: 300,
    buys: 4,
    buyers: 5,
    volume_usd: '250.25',
  });
});

test('maps verified batch fields without manufacturing migration or trade time', () => {
  const attributes = {
    transactions: Object.fromEntries(
      ['m5', 'm15', 'm30'].map((key) => [key, { buys: 4, sells: 3, buyers: 5, sellers: 4 }]),
    ),
    volume_usd: { m5: '250', m15: '500', m30: '750' },
    buy_volume_usd: { m5: '150', m15: '300', m30: '450' },
    sell_volume_usd: { m5: '100', m15: '200', m30: '300' },
    net_buy_volume_usd: { m5: '50', m15: '100', m30: '150' },
    base_token_price_usd: '1.25',
    base_token_balance: '800',
    quote_token_balance: '1000',
  };
  const parsedPool = parsePool(
    {
      pool_address: pool,
      base_token_address: token,
      quote_token_address: 'USDC111',
      reserve_usd: '1000',
      volume_usd_24h: '5000',
      trades_24h: 10,
      pool_created_at: 0,
      rest_supported: true,
      g2_supported: true,
    },
    'sol',
    token,
  );
  assert.equal(parsedPool.status, 'complete');
  if (parsedPool.status !== 'complete') return;
  const screening = level1ScreeningRawForPool(
    { pool_address: pool, reserve_usd: '1000' },
    parsedPool.pool,
    attributes,
  );
  assert.equal(screening.last_trade_at, undefined);
  assert.equal(screening.migration, undefined);
  assert.equal(((screening.windows as Record<string, Record<string, unknown>>).m5 ?? {}).buyers, 5);
});

test('matches BSC token and pool addresses without depending on checksum casing', () => {
  const bscToken = '0xabcdef0123456789012345678901234567890123';
  const bscPool = '0x1234567890abcdef1234567890abcdef12345678';
  const mixedCase = (address: string) => `0x${address.slice(2).toUpperCase()}`;
  const response = {
    data: [
      {
        type: 'token',
        attributes: { address: mixedCase(bscToken) },
        relationships: {
          top_pools: { data: [{ id: `bsc_${bscPool}`, type: 'pool' }] },
        },
      },
    ],
    included: [
      {
        type: 'pool',
        id: `bsc_${bscPool}`,
        attributes: {
          address: mixedCase(bscPool),
          reserve_in_usd: '1000',
          pool_created_at: '2026-08-21T00:00:00Z',
          volume_usd: { h24: '250' },
          transactions: { h24: { buys: 4, sells: 3 } },
        },
        relationships: {
          base_token: { data: { id: `bsc_${mixedCase(bscToken)}` } },
          quote_token: {
            data: { id: 'bsc_0x0000000000000000000000000000000000000001' },
          },
        },
      },
    ],
  };
  const raws = poolRawsForToken(response, 'bsc', bscToken);
  assert.equal(raws.length, 1);
  const parsed = parsePool(raws[0]!, 'bsc', bscToken);
  assert.equal(parsed.status, 'complete');
  if (parsed.status === 'complete') assert.equal(parsed.pool.targetSide, 'base');
});
