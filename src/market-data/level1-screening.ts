import type { DataState } from '../providers/types.js';
import {
  parseAddress,
  parseDecimalString,
  parseInteger,
  parseTimestampMs,
} from '../providers/parsing.js';
import type { WindowKey } from '../pipeline/age.js';
import type { Level1Snapshot } from './level1.js';
import type { CanonicalPool } from './pools.js';

export type RawLevel1Screening = Record<string, unknown>;

export type Level1ScreeningWindow = {
  state: Extract<DataState, 'complete' | 'partial'>;
  coverageSeconds: number;
  buys: number;
  sells: number;
  buyers: number;
  sellers: number;
  volumeUsd: string;
  buyVolumeUsd: string;
  sellVolumeUsd: string;
  netBuyUsd: string;
};

export type Level1ScreeningSnapshot = {
  chain: CanonicalPool['chain'];
  poolAddress: string;
  tokenAddress: string;
  baseTokenAddress: string;
  quoteTokenAddress: string;
  targetSide: CanonicalPool['targetSide'];
  observedAt: number;
  dataState: Extract<DataState, 'complete'>;
  poolStatus: 'stable';
  reserveUsd: string;
  priceUsd: string;
  poolAgeSeconds: number;
  baseTokenBalance: string;
  quoteTokenBalance: string;
  windows: Partial<Record<WindowKey, Level1ScreeningWindow>>;
  migration?: { state: 'migrating' | 'completed'; targetPoolAddress?: string };
};

export type Level1ScreeningParseResult =
  | { status: 'complete'; snapshot: Level1ScreeningSnapshot }
  | { status: 'incomplete' | 'unstable'; reasons: string[] };

export type LastTradeEvidence = {
  source: 'rest' | 'g2';
  chain: CanonicalPool['chain'];
  poolAddress: string;
  tokenAddress: string;
  eventAt: number;
  observedAt: number;
};

export function parseLevel1ScreeningSnapshot(
  raw: RawLevel1Screening,
  boundPool: CanonicalPool,
  observedAt: number,
): Level1ScreeningParseResult {
  const incomplete: string[] = [];
  const unstable: string[] = [];
  try {
    if (!Number.isSafeInteger(observedAt) || observedAt < 0)
      return { status: 'incomplete', reasons: ['invalid:observed_at'] };
    const poolAddress = readAddress(raw, 'pool_address', incomplete);
    const tokenAddress = readAddress(raw, 'token_address', incomplete);
    const baseTokenAddress = readAddress(raw, 'base_token_address', incomplete);
    const quoteTokenAddress = readAddress(raw, 'quote_token_address', incomplete);
    if (poolAddress && !sameAddress(boundPool.chain, poolAddress, boundPool.poolAddress))
      unstable.push('identity:pool_address');
    if (tokenAddress && !sameAddress(boundPool.chain, tokenAddress, boundPool.tokenAddress))
      unstable.push('identity:token_address');
    if (
      baseTokenAddress &&
      !sameAddress(boundPool.chain, baseTokenAddress, boundPool.baseTokenAddress)
    )
      unstable.push('identity:base_token');
    if (
      quoteTokenAddress &&
      !sameAddress(boundPool.chain, quoteTokenAddress, boundPool.quoteTokenAddress)
    )
      unstable.push('identity:quote_token');

    const targetSide = raw.target_side;
    if (targetSide !== 'base' && targetSide !== 'quote') incomplete.push('invalid:target_side');
    else if (targetSide !== boundPool.targetSide) unstable.push('identity:target_side');
    const restSupported = readBoolean(raw, 'rest_supported', incomplete);
    const g2Supported = readBoolean(raw, 'g2_supported', incomplete);
    if (restSupported === false) unstable.push('capability:rest_unsupported');
    if (g2Supported === false) unstable.push('capability:g2_unsupported');

    const migration = readMigration(raw.migration, boundPool, incomplete, unstable);
    if (unstable.length > 0) return { status: 'unstable', reasons: unstable };

    const reserveUsd = readDecimal(raw, 'reserve_usd', incomplete);
    const priceUsd = readDecimal(raw, 'price_usd', incomplete);
    const baseTokenBalance = readDecimal(raw, 'base_token_balance', incomplete);
    const quoteTokenBalance = readDecimal(raw, 'quote_token_balance', incomplete);
    const poolCreatedAt = readTimestamp(raw, 'pool_created_at', incomplete);
    const windows = readWindows(raw.windows, poolCreatedAt, observedAt, incomplete);
    if (
      incomplete.length > 0 ||
      !poolAddress ||
      !tokenAddress ||
      !baseTokenAddress ||
      !quoteTokenAddress ||
      (targetSide !== 'base' && targetSide !== 'quote') ||
      restSupported !== true ||
      g2Supported !== true ||
      reserveUsd === undefined ||
      priceUsd === undefined ||
      baseTokenBalance === undefined ||
      quoteTokenBalance === undefined ||
      poolCreatedAt === undefined
    )
      return { status: 'incomplete', reasons: incomplete };

    return {
      status: 'complete',
      snapshot: {
        chain: boundPool.chain,
        poolAddress,
        tokenAddress,
        baseTokenAddress,
        quoteTokenAddress,
        targetSide,
        observedAt,
        dataState: 'complete',
        poolStatus: 'stable',
        reserveUsd,
        priceUsd,
        poolAgeSeconds: Math.max(0, Math.floor((observedAt - poolCreatedAt) / 1000)),
        baseTokenBalance,
        quoteTokenBalance,
        windows,
        ...(migration ? { migration } : {}),
      },
    };
  } catch {
    return { status: 'incomplete', reasons: ['invalid:level1_screening'] };
  }
}

export function promoteLevel1ScreeningSnapshot(
  screening: Level1ScreeningSnapshot,
  evidence: LastTradeEvidence,
): { status: 'complete'; snapshot: Level1Snapshot } | { status: 'incomplete'; reasons: string[] } {
  const reasons: string[] = [];
  if (screening.chain !== evidence.chain) reasons.push('identity:chain');
  if (!sameAddress(screening.chain, screening.poolAddress, evidence.poolAddress))
    reasons.push('identity:pool_address');
  if (!sameAddress(screening.chain, screening.tokenAddress, evidence.tokenAddress))
    reasons.push('identity:token_address');
  if (!Number.isSafeInteger(evidence.eventAt) || evidence.eventAt < 0)
    reasons.push('invalid:last_trade_at');
  if (!Number.isSafeInteger(evidence.observedAt) || evidence.observedAt < evidence.eventAt)
    reasons.push('invalid:trade_observed_at');
  const observedAt = Math.max(screening.observedAt, evidence.observedAt);
  if (evidence.eventAt > observedAt) reasons.push('invalid:future_last_trade_at');
  const m5 = screening.windows.m5;
  if (!m5) reasons.push('missing:window:m5');
  if (reasons.length > 0 || !m5) return { status: 'incomplete', reasons };
  return {
    status: 'complete',
    snapshot: {
      chain: screening.chain,
      poolAddress: screening.poolAddress,
      tokenAddress: screening.tokenAddress,
      observedAt,
      dataState: 'complete',
      poolStatus: screening.poolStatus,
      reserveUsd: screening.reserveUsd,
      priceUsd: screening.priceUsd,
      buys: m5.buys,
      sells: m5.sells,
      buyers: m5.buyers,
      sellers: m5.sellers,
      volumeUsd: m5.volumeUsd,
      netBuyUsd: m5.netBuyUsd,
      poolAgeSeconds: screening.poolAgeSeconds,
      lastTradeAt: evidence.eventAt,
      windows: Object.fromEntries(
        Object.entries(screening.windows).map(([key, value]) => [
          key,
          value
            ? {
                state: value.state,
                coverageSeconds: value.coverageSeconds,
                buys: value.buys,
                buyers: value.buyers,
                volumeUsd: value.volumeUsd,
              }
            : value,
        ]),
      ),
    },
  };
}

function readWindows(
  value: unknown,
  poolCreatedAt: number | undefined,
  observedAt: number,
  reasons: string[],
): Partial<Record<WindowKey, Level1ScreeningWindow>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    reasons.push('missing:windows');
    return {};
  }
  const windows: Partial<Record<WindowKey, Level1ScreeningWindow>> = {};
  for (const [key, seconds] of [
    ['m5', 300],
    ['m15', 900],
    ['m30', 1800],
  ] as const) {
    const raw = (value as Record<string, unknown>)[key];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      reasons.push(`missing:window:${key}`);
      continue;
    }
    const item = raw as Record<string, unknown>;
    try {
      const ageSeconds =
        poolCreatedAt === undefined
          ? 0
          : Math.max(0, Math.floor((observedAt - poolCreatedAt) / 1000));
      windows[key] = {
        state: ageSeconds >= seconds ? 'complete' : 'partial',
        coverageSeconds: Math.max(1, Math.min(ageSeconds, seconds)),
        buys: parseInteger(item.buys, { min: 0 }),
        sells: parseInteger(item.sells, { min: 0 }),
        buyers: parseInteger(item.buyers, { min: 0 }),
        sellers: parseInteger(item.sellers, { min: 0 }),
        volumeUsd: parseDecimalString(item.volume_usd, { nonNegative: true }).toString(),
        buyVolumeUsd: parseDecimalString(item.buy_volume_usd, { nonNegative: true }).toString(),
        sellVolumeUsd: parseDecimalString(item.sell_volume_usd, { nonNegative: true }).toString(),
        netBuyUsd: parseDecimalString(item.net_buy_usd).toString(),
      };
    } catch {
      reasons.push(`invalid:window:${key}`);
    }
  }
  return windows;
}

function readMigration(
  value: unknown,
  pool: CanonicalPool,
  incomplete: string[],
  unstable: string[],
): Level1ScreeningSnapshot['migration'] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    incomplete.push('invalid:migration');
    return undefined;
  }
  const item = value as Record<string, unknown>;
  if (item.state !== 'migrating' && item.state !== 'completed') {
    incomplete.push('invalid:migration_state');
    return undefined;
  }
  const target = item.target_pool_address;
  if (target !== undefined && typeof target !== 'string') {
    incomplete.push('invalid:migration_target_pool');
    return undefined;
  }
  if (item.state === 'migrating') unstable.push('migration:in_progress');
  if (item.state === 'completed' && target === undefined)
    incomplete.push('missing:migration_target_pool');
  if (
    item.state === 'completed' &&
    typeof target === 'string' &&
    !sameAddress(pool.chain, target, pool.poolAddress)
  )
    unstable.push('migration:target_pool_changed');
  return {
    state: item.state,
    ...(typeof target === 'string' ? { targetPoolAddress: target } : {}),
  };
}

function readAddress(raw: RawLevel1Screening, field: string, reasons: string[]) {
  try {
    return parseAddress(raw[field]);
  } catch {
    reasons.push(`${field in raw ? 'invalid' : 'missing'}:${field}`);
    return undefined;
  }
}

function readDecimal(raw: RawLevel1Screening, field: string, reasons: string[]) {
  try {
    return parseDecimalString(raw[field], { nonNegative: true }).toString();
  } catch {
    reasons.push(`${field in raw ? 'invalid' : 'missing'}:${field}`);
    return undefined;
  }
}

function readTimestamp(raw: RawLevel1Screening, field: string, reasons: string[]) {
  try {
    return parseTimestampMs(raw[field]);
  } catch {
    reasons.push(`${field in raw ? 'invalid' : 'missing'}:${field}`);
    return undefined;
  }
}

function readBoolean(raw: RawLevel1Screening, field: string, reasons: string[]) {
  if (typeof raw[field] === 'boolean') return raw[field];
  reasons.push(`${field in raw ? 'invalid' : 'missing'}:${field}`);
  return undefined;
}

function sameAddress(chain: CanonicalPool['chain'], left: string, right: string) {
  return chain === 'bsc' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
