import type { RawPool } from '../market-data/pools.js';
import type { CanonicalPool } from '../market-data/pools.js';
import type { RawLevel1 } from '../market-data/level1.js';
import type { Candle } from '../outcomes/evaluation.js';
import { Decimal } from 'decimal.js';
import { parseDecimalString, parseInteger } from './parsing.js';

type JsonRecord = Record<string, unknown>;

export type CoinGeckoOhlcvRow = {
  timestampMs: number;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  closePrice: string;
  volume: string;
};

export function parseCoinGeckoOhlcv30s(
  response: JsonRecord,
  pool: CanonicalPool,
  observedAt: number,
): CoinGeckoOhlcvRow[] {
  const rows = Array.isArray(response.data) ? response.data : [];
  return rows
    .flatMap((row) => {
      if (!Array.isArray(row) || row.length !== 6 || typeof row[0] !== 'number') return [];
      try {
        const rawTimestamp = parseInteger(row[0], { min: 0 });
        const timestampMs = rawTimestamp < 1_000_000_000_000 ? rawTimestamp * 1000 : rawTimestamp;
        parseInteger(timestampMs, { min: 0 });
        const values = row.slice(1).map((value) => {
          if (typeof value !== 'string') throw new Error('Invalid OHLCV value');
          parseDecimalString(value, { nonNegative: true });
          return value;
        });
        if (values.some((value) => value === '')) throw new Error('Invalid OHLCV value');
        const [openPrice, highPrice, lowPrice, closePrice, volume] = values;
        if (!openPrice || !highPrice || !lowPrice || !closePrice || !volume) return [];
        const open = new Decimal(openPrice);
        const high = new Decimal(highPrice);
        const low = new Decimal(lowPrice);
        const close = new Decimal(closePrice);
        if (
          high.lessThan(open) ||
          high.lessThan(close) ||
          low.greaterThan(open) ||
          low.greaterThan(close)
        )
          return [];
        return [{ timestampMs, openPrice, highPrice, lowPrice, closePrice, volume }];
      } catch {
        return [];
      }
    })
    .filter((row) => row.timestampMs + 30_000 <= observedAt);
}

export function toCandle(
  pool: CanonicalPool,
  row: CoinGeckoOhlcvRow,
  observedAt: number,
  revision: number,
): Candle {
  return {
    chain: pool.chain,
    poolAddress: pool.poolAddress,
    tokenAddress: pool.tokenAddress,
    targetSide: pool.targetSide,
    intervalSeconds: 30,
    openTime: row.timestampMs,
    revision,
    observedAt,
    isClosed: row.timestampMs + 30_000 <= observedAt,
    openPrice: row.openPrice,
    highPrice: row.highPrice,
    lowPrice: row.lowPrice,
    closePrice: row.closePrice,
    volume: row.volume,
  };
}

export function tokenAddressFromCoinGeckoItem(item: JsonRecord): string | undefined {
  const attributes = asRecord(item.attributes);
  return typeof attributes?.address === 'string' ? attributes.address : undefined;
}

export function poolRawsForToken(
  response: JsonRecord,
  network: 'solana' | 'bsc',
  tokenAddress: string,
): RawPool[] {
  const token = (Array.isArray(response.data) ? response.data : []).find((item) => {
    const address = tokenAddressFromCoinGeckoItem(asRecord(item));
    return address !== undefined && sameAddress(network, address, tokenAddress);
  });
  if (!token) return [];

  const relationships = asRecord(asRecord(token).relationships);
  const topPoolsValue = asRecord(relationships.top_pools).data;
  const topPools = Array.isArray(topPoolsValue) ? topPoolsValue : [];
  const allowedIds = new Set(
    topPools
      .map((item: unknown) => asRecord(item).id)
      .filter((value): value is string => typeof value === 'string'),
  );
  const included = (Array.isArray(response.included) ? response.included : [])
    .map(asRecord)
    .filter((item) => item.type === 'pool');

  return included
    .filter((item) => {
      const id = item.id;
      return allowedIds.size === 0 || (typeof id === 'string' && allowedIds.has(id));
    })
    .map((item) => toRawPool(item, network, tokenAddress));
}

export function poolRawForAddress(
  response: JsonRecord,
  network: 'solana' | 'bsc',
  poolAddress: string,
  tokenAddress: string,
): RawPool | undefined {
  const item = (Array.isArray(response.data) ? response.data : [])
    .map(asRecord)
    .find((candidate) => {
      const address = asRecord(candidate.attributes).address;
      return typeof address === 'string' && sameAddress(network, address, poolAddress);
    });
  return item ? toRawPool(item, network, tokenAddress) : undefined;
}

export function latestTradeAt(response: JsonRecord): number | undefined {
  const timestamps = (Array.isArray(response.data) ? response.data : [])
    .map((item) => asRecord(asRecord(item).attributes).block_timestamp)
    .filter((value): value is string => typeof value === 'string')
    .map((value) => Date.parse(value))
    .filter((value) => Number.isSafeInteger(value) && value >= 0);
  return timestamps.length === 0 ? undefined : Math.max(...timestamps);
}

export function level1RawForPool(
  item: RawPool,
  pool: CanonicalPool,
  attributes: JsonRecord,
  observedAt: number,
  lastTradeAt: number | undefined,
): RawLevel1 {
  const transactions = asRecord(attributes.transactions);
  const window = asRecord(transactions.m5);
  const volumes = asRecord(attributes.volume_usd);
  const volume = volumes.m5;
  const netBuy = asRecord(attributes.net_buy_volume_usd).m5;
  const priceField = pool.targetSide === 'base' ? 'base_token_price_usd' : 'quote_token_price_usd';
  const ageSeconds =
    Number.isSafeInteger(pool.poolCreatedAt) && pool.poolCreatedAt <= observedAt
      ? Math.floor((observedAt - pool.poolCreatedAt) / 1000)
      : -1;
  return {
    pool_address: item.pool_address,
    token_address: pool.tokenAddress,
    pool_status: 'stable',
    reserve_usd: item.reserve_usd,
    price_usd: attributes[priceField],
    buys: window.buys,
    sells: window.sells,
    buyers: window.buyers,
    sellers: window.sellers,
    volume_usd: volume,
    net_buy_usd: netBuy,
    pool_age_seconds: ageSeconds,
    last_trade_at: lastTradeAt,
    windows: Object.fromEntries(
      (['m5', 'm15', 'm30'] as const).map((key) => {
        const seconds = key === 'm5' ? 300 : key === 'm15' ? 900 : 1_800;
        const values = asRecord(transactions[key]);
        return [
          key,
          {
            state: ageSeconds >= seconds ? 'complete' : ageSeconds >= 0 ? 'partial' : 'invalid',
            coverage_seconds: ageSeconds < 0 ? 0 : Math.max(1, Math.min(ageSeconds, seconds)),
            buys: values.buys,
            buyers: values.buyers,
            volume_usd: volumes[key],
          },
        ];
      }),
    ),
  };
}

function toRawPool(item: JsonRecord, network: 'solana' | 'bsc', tokenAddress: string): RawPool {
  const attributes = asRecord(item.attributes);
  const relationships = asRecord(item.relationships);
  const baseTokenAddress = relationshipAddress(relationships.base_token, network);
  const quoteTokenAddress = relationshipAddress(relationships.quote_token, network);
  const poolAddress = typeof attributes.address === 'string' ? attributes.address : item.id;
  const transactions = asRecord(attributes.transactions);
  const volume = asRecord(attributes.volume_usd);
  const createdAt =
    typeof attributes.pool_created_at === 'string'
      ? Date.parse(attributes.pool_created_at)
      : Number.NaN;
  const trades = asRecord(transactions.h24);
  const buys = safeNonNegativeInteger(trades.buys);
  const sells = safeNonNegativeInteger(trades.sells);
  const trades24h =
    buys !== undefined && sells !== undefined && buys <= Number.MAX_SAFE_INTEGER - sells
      ? buys + sells
      : undefined;

  return {
    pool_address: poolAddress,
    base_token_address: baseTokenAddress,
    quote_token_address: quoteTokenAddress,
    reserve_usd: attributes.reserve_in_usd,
    volume_usd_24h: volume.h24,
    trades_24h: trades24h,
    pool_created_at: createdAt,
    // These are provider capability facts for the configured Analyst/G2 adapters.
    // Live health and subscription confirmation remain separate runtime gates.
    rest_supported: typeof poolAddress === 'string' && poolAddress.length > 0,
    g2_supported: network === 'solana' || network === 'bsc',
    token_address: tokenAddress,
  };
}

function relationshipAddress(value: unknown, network: 'solana' | 'bsc'): string | undefined {
  const data = asRecord(asRecord(value).data);
  const id = data.id;
  if (typeof id !== 'string') return undefined;
  const prefix = `${network}_`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

function sameAddress(network: 'solana' | 'bsc', left: string, right: string): boolean {
  return network === 'bsc' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function safeNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
