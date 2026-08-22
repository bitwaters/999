import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCoinGeckoOhlcv30s, toCandle } from './coingecko-adapter.js';
import type { CanonicalPool } from '../market-data/pools.js';

const pool: CanonicalPool = {
  chain: 'sol',
  poolAddress: 'pool',
  tokenAddress: 'token',
  baseTokenAddress: 'token',
  quoteTokenAddress: 'usd',
  targetSide: 'base',
  reserveUsd: '1000',
  volumeUsd24h: '100',
  trades24h: 10,
  poolCreatedAt: 0,
  restSupported: true,
  g2Supported: true,
  identityKey: 'sol:pool:token',
};

test('CoinGecko OHLCV seconds become closed canonical 30s candles', () => {
  const rows = parseCoinGeckoOhlcv30s(
    {
      data: {
        id: 'pool',
        type: 'ohlcv_request_response',
        attributes: { ohlcv_list: [[1710000000, 1, 1.2, 0.9, 1.1, 100]] },
      },
    },
    pool,
    1710000040000,
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(toCandle(pool, rows[0]!, 1710000040000, 0), {
    chain: 'sol',
    poolAddress: 'pool',
    tokenAddress: 'token',
    targetSide: 'base',
    intervalSeconds: 30,
    openTime: 1710000000000,
    revision: 0,
    observedAt: 1710000040000,
    isClosed: true,
    openPrice: '1',
    highPrice: '1.2',
    lowPrice: '0.9',
    closePrice: '1.1',
    volume: '100',
  });
});

test('invalid or still-open OHLCV rows are excluded conservatively', () => {
  const rows = parseCoinGeckoOhlcv30s(
    {
      data: {
        id: 'pool',
        type: 'ohlcv_request_response',
        attributes: {
          ohlcv_list: [
            [1710000000, 1, 0.8, 0.9, 1, 1],
            [1710000030, 1, 1, 1, 1, 1],
          ],
        },
      },
    },
    pool,
    1710000055000,
  );
  assert.equal(rows.length, 0);
});
