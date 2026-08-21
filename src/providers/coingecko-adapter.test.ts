import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePool, selectPrimaryPool } from '../market-data/pools.js';
import {
  latestTradeAt,
  level1RawForPool,
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
});
