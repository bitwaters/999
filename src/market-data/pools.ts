import {
  parseAddress,
  parseDecimalString,
  parseInteger,
  parseTimestampMs,
} from '../providers/parsing.js';

export type PoolTargetSide = 'base' | 'quote';

export type RawPool = Record<string, unknown>;

export type CanonicalPool = {
  chain: 'sol' | 'bsc';
  poolAddress: string;
  tokenAddress: string;
  baseTokenAddress: string;
  quoteTokenAddress: string;
  targetSide: PoolTargetSide;
  reserveUsd: string;
  volumeUsd24h: string;
  trades24h: number;
  poolCreatedAt: number;
  restSupported: boolean;
  g2Supported: boolean;
  identityKey: string;
};

export type PoolParseResult =
  { status: 'complete'; pool: CanonicalPool } | { status: 'invalid'; reasons: string[] };

export type PoolSelection =
  | { status: 'resolved'; pool: CanonicalPool }
  | { status: 'unresolved' | 'invalid'; reason: string };

export function parsePool(
  raw: RawPool,
  chain: CanonicalPool['chain'],
  tokenAddress: string,
): PoolParseResult {
  const reasons: string[] = [];
  try {
    const poolAddress = requiredAddress(raw, 'pool_address');
    const baseTokenAddress = requiredAddress(raw, 'base_token_address');
    const quoteTokenAddress = requiredAddress(raw, 'quote_token_address');
    parseAddress(tokenAddress);
    if (baseTokenAddress === quoteTokenAddress) reasons.push('identity:base_quote_same');
    if (tokenAddress !== baseTokenAddress && tokenAddress !== quoteTokenAddress)
      reasons.push('identity:token_not_in_pool');
    const targetSide: PoolTargetSide | undefined =
      tokenAddress === baseTokenAddress
        ? 'base'
        : tokenAddress === quoteTokenAddress
          ? 'quote'
          : undefined;
    const reserveUsd = requiredDecimal(raw, 'reserve_usd', reasons);
    const volumeUsd24h = optionalDecimal(raw, 'volume_usd_24h', reasons) ?? '0';
    const trades24h = optionalInteger(raw, 'trades_24h', reasons) ?? 0;
    const poolCreatedAt = requiredTimestamp(raw, 'pool_created_at', reasons);
    const restSupported = requiredBoolean(raw, 'rest_supported', reasons);
    const g2Supported = requiredBoolean(raw, 'g2_supported', reasons);
    if (
      reasons.length > 0 ||
      !targetSide ||
      !reserveUsd ||
      poolCreatedAt === undefined ||
      restSupported === undefined ||
      g2Supported === undefined
    )
      return { status: 'invalid', reasons };
    return {
      status: 'complete',
      pool: {
        chain,
        poolAddress,
        tokenAddress,
        baseTokenAddress,
        quoteTokenAddress,
        targetSide,
        reserveUsd,
        volumeUsd24h,
        trades24h,
        poolCreatedAt,
        restSupported,
        g2Supported,
        identityKey: `${chain}:${poolAddress}:${tokenAddress}`,
      },
    };
  } catch (error) {
    return {
      status: 'invalid',
      reasons: [error instanceof Error ? error.message : 'invalid:pool'],
    };
  }
}

export function selectPrimaryPool(pools: readonly CanonicalPool[]): PoolSelection {
  const eligible = pools.filter((pool) => pool.restSupported && pool.g2Supported);
  if (eligible.length === 0)
    return {
      status: pools.length === 0 ? 'unresolved' : 'invalid',
      reason: 'pool:no_rest_and_g2_candidate',
    };
  const sorted = [...eligible].sort((left, right) => {
    const reserve = parseDecimalString(right.reserveUsd).comparedTo(
      parseDecimalString(left.reserveUsd),
    );
    if (reserve !== 0) return reserve;
    const volume = parseDecimalString(right.volumeUsd24h).comparedTo(
      parseDecimalString(left.volumeUsd24h),
    );
    if (volume !== 0) return volume;
    if (right.trades24h !== left.trades24h) return right.trades24h - left.trades24h;
    return left.poolAddress < right.poolAddress ? -1 : left.poolAddress > right.poolAddress ? 1 : 0;
  });
  return { status: 'resolved', pool: sorted[0]! };
}

function requiredAddress(raw: RawPool, field: string): string {
  const value = raw[field];
  return parseAddress(value);
}

function requiredDecimal(raw: RawPool, field: string, reasons: string[]): string | undefined {
  if (!(field in raw)) {
    reasons.push(`missing:${field}`);
    return undefined;
  }
  try {
    return parseDecimalString(raw[field], { nonNegative: true }).toString();
  } catch {
    reasons.push(`invalid:${field}`);
    return undefined;
  }
}

function optionalDecimal(raw: RawPool, field: string, reasons: string[]): string | undefined {
  if (!(field in raw) || raw[field] === undefined || raw[field] === null) return undefined;
  try {
    return parseDecimalString(raw[field], { nonNegative: true }).toString();
  } catch {
    reasons.push(`invalid:${field}`);
    return undefined;
  }
}

function optionalInteger(raw: RawPool, field: string, reasons: string[]): number | undefined {
  if (!(field in raw) || raw[field] === undefined || raw[field] === null) return undefined;
  try {
    return parseInteger(raw[field], { min: 0 });
  } catch {
    reasons.push(`invalid:${field}`);
    return undefined;
  }
}

function requiredTimestamp(raw: RawPool, field: string, reasons: string[]): number | undefined {
  if (!(field in raw)) {
    reasons.push(`missing:${field}`);
    return undefined;
  }
  try {
    return parseTimestampMs(raw[field]);
  } catch {
    reasons.push(`invalid:${field}`);
    return undefined;
  }
}

function requiredBoolean(raw: RawPool, field: string, reasons: string[]): boolean | undefined {
  if (!(field in raw)) {
    reasons.push(`missing:${field}`);
    return undefined;
  }
  if (typeof raw[field] !== 'boolean') {
    reasons.push(`invalid:${field}`);
    return undefined;
  }
  return raw[field];
}
