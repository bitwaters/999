import type { RawPool } from '../market-data/pools.js';

type JsonRecord = Record<string, unknown>;

export function tokenAddressFromCoinGeckoItem(item: JsonRecord): string | undefined {
  const attributes = asRecord(item.attributes);
  return typeof attributes?.address === 'string' ? attributes.address : undefined;
}

export function poolRawsForToken(
  response: JsonRecord,
  network: 'solana' | 'bsc',
  tokenAddress: string,
): RawPool[] {
  const token = (Array.isArray(response.data) ? response.data : []).find(
    (item) => tokenAddressFromCoinGeckoItem(asRecord(item)) === tokenAddress,
  );
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

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function safeNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
