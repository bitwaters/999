import {
  parseAddress,
  parseDecimalString,
  parseInteger,
  parseTimestampMs,
} from '../providers/parsing.js';
import type { DataState } from '../providers/types.js';
import type { CanonicalPool } from './pools.js';

export type RawLevel1 = Record<string, unknown>;

export type Level1Snapshot = {
  chain: CanonicalPool['chain'];
  poolAddress: string;
  tokenAddress: string;
  observedAt: number;
  dataState: Extract<DataState, 'complete' | 'invalid'>;
  poolStatus: 'stable' | 'unstable';
  reserveUsd: string;
  priceUsd: string;
  buys: number;
  sells: number;
  buyers: number;
  sellers: number;
  volumeUsd: string;
  netBuyUsd: string;
  poolAgeSeconds: number;
  lastTradeAt: number;
};

export type Level1ParseResult =
  { status: 'complete'; snapshot: Level1Snapshot } | { status: 'invalid'; reasons: string[] };

export function parseLevel1Snapshot(
  raw: RawLevel1,
  pool: CanonicalPool,
  observedAt: number,
): Level1ParseResult {
  const reasons: string[] = [];
  try {
    const poolAddress = requiredAddress(raw, 'pool_address');
    const tokenAddress = requiredAddress(raw, 'token_address');
    if (poolAddress !== pool.poolAddress) reasons.push('identity:pool_address');
    if (tokenAddress !== pool.tokenAddress) reasons.push('identity:token_address');
    const poolStatus = requiredPoolStatus(raw.pool_status, reasons);
    const reserveUsd = requiredDecimal(raw, 'reserve_usd', reasons);
    const priceUsd = requiredDecimal(raw, 'price_usd', reasons);
    const buys = requiredInteger(raw, 'buys', reasons);
    const sells = requiredInteger(raw, 'sells', reasons);
    const buyers = requiredInteger(raw, 'buyers', reasons);
    const sellers = requiredInteger(raw, 'sellers', reasons);
    const volumeUsd = requiredDecimal(raw, 'volume_usd', reasons);
    const netBuyUsd = requiredDecimalOrSigned(raw, 'net_buy_usd', reasons);
    const poolAgeSeconds = requiredInteger(raw, 'pool_age_seconds', reasons);
    const lastTradeAt = requiredTimestamp(raw, 'last_trade_at', reasons);
    if (!Number.isSafeInteger(observedAt) || observedAt < 0) reasons.push('invalid:observed_at');
    if (lastTradeAt !== undefined && lastTradeAt > observedAt)
      reasons.push('invalid:future_last_trade_at');
    if (
      reasons.length > 0 ||
      poolStatus === undefined ||
      reserveUsd === undefined ||
      priceUsd === undefined ||
      buys === undefined ||
      sells === undefined ||
      buyers === undefined ||
      sellers === undefined ||
      volumeUsd === undefined ||
      netBuyUsd === undefined ||
      poolAgeSeconds === undefined ||
      lastTradeAt === undefined
    )
      return { status: 'invalid', reasons };
    return {
      status: 'complete',
      snapshot: {
        chain: pool.chain,
        poolAddress,
        tokenAddress,
        observedAt,
        dataState: 'complete',
        poolStatus,
        reserveUsd,
        priceUsd,
        buys,
        sells,
        buyers,
        sellers,
        volumeUsd,
        netBuyUsd,
        poolAgeSeconds,
        lastTradeAt,
      },
    };
  } catch (error) {
    return {
      status: 'invalid',
      reasons: [error instanceof Error ? error.message : 'invalid:level1'],
    };
  }
}

export function isLevel1Fresh(
  snapshot: Level1Snapshot,
  now: number,
  freshnessSeconds: number,
): boolean {
  return (
    Number.isSafeInteger(now) &&
    now >= snapshot.observedAt &&
    Number.isFinite(freshnessSeconds) &&
    freshnessSeconds > 0 &&
    now - snapshot.observedAt <= freshnessSeconds * 1000
  );
}

export type Level1Batch = { chain: CanonicalPool['chain']; pools: CanonicalPool[] };

export function createLevel1Batches(
  pools: readonly CanonicalPool[],
  maxPoolsPerBatch = 50,
): Level1Batch[] {
  if (!Number.isSafeInteger(maxPoolsPerBatch) || maxPoolsPerBatch <= 0)
    throw new Error('Invalid Level 1 batch size');
  const grouped = new Map<CanonicalPool['chain'], CanonicalPool[]>();
  for (const pool of pools) {
    if (!pool.restSupported || !pool.g2Supported) continue;
    const group = grouped.get(pool.chain) ?? [];
    if (!group.some((existing) => existing.identityKey === pool.identityKey)) group.push(pool);
    grouped.set(pool.chain, group);
  }
  const batches: Level1Batch[] = [];
  for (const chain of ['sol', 'bsc'] as const) {
    const group = grouped.get(chain) ?? [];
    for (let index = 0; index < group.length; index += maxPoolsPerBatch)
      batches.push({ chain, pools: group.slice(index, index + maxPoolsPerBatch) });
  }
  return batches;
}

export class Level1Batcher {
  private readonly pending = new Map<string, CanonicalPool>();
  private flushAt: number | undefined;
  private nextRefreshAt: number | undefined;

  constructor(
    private readonly options: {
      maxPoolsPerBatch: number;
      mergeDelayMs: number;
      refreshIntervalSeconds: number;
    },
  ) {
    if (
      !Number.isSafeInteger(options.maxPoolsPerBatch) ||
      options.maxPoolsPerBatch <= 0 ||
      !Number.isSafeInteger(options.mergeDelayMs) ||
      options.mergeDelayMs < 200 ||
      options.mergeDelayMs > 500 ||
      !Number.isSafeInteger(options.refreshIntervalSeconds) ||
      options.refreshIntervalSeconds < 30 ||
      options.refreshIntervalSeconds > 60
    )
      throw new Error('Invalid Level 1 batcher configuration');
  }

  enqueue(pools: readonly CanonicalPool[], now: number): number {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid Level 1 enqueue time');
    for (const pool of pools) this.pending.set(pool.identityKey, pool);
    this.flushAt ??= now + this.options.mergeDelayMs;
    return this.flushAt;
  }

  flush(now: number): Level1Batch[] {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid Level 1 flush time');
    if (this.flushAt === undefined || now < this.flushAt) return [];
    const batches = createLevel1Batches([...this.pending.values()], this.options.maxPoolsPerBatch);
    this.pending.clear();
    this.flushAt = undefined;
    this.nextRefreshAt = now + this.options.refreshIntervalSeconds * 1000;
    return batches;
  }

  shouldRefresh(now: number): boolean {
    return this.nextRefreshAt !== undefined && now >= this.nextRefreshAt;
  }
}

export function canEnterArmed(
  snapshot: Level1Snapshot,
  now: number,
  buyersFreshnessSeconds: number,
): { status: 'pass' } | { status: 'incomplete' | 'rejected'; reason: string } {
  if (snapshot.dataState !== 'complete')
    return { status: 'incomplete', reason: 'level1:data_state' };
  if (snapshot.poolStatus !== 'stable') return { status: 'rejected', reason: 'pool:unstable' };
  if (!isLevel1Fresh(snapshot, now, buyersFreshnessSeconds))
    return { status: 'incomplete', reason: 'level1:stale' };
  return { status: 'pass' };
}

export type Level1LifecycleState =
  'qualified' | 'armed' | 'confirmed-pending-anchor' | 'incomplete';

export function transitionLevel1State(
  current: Level1LifecycleState,
  snapshot: Level1Snapshot,
  now: number,
  buyersFreshnessSeconds: number,
): { state: Level1LifecycleState; reason?: string } {
  const decision = canEnterArmed(snapshot, now, buyersFreshnessSeconds);
  if (decision.status === 'pass') {
    if (current === 'qualified') return { state: 'armed' };
    return { state: current };
  }
  if (current === 'qualified') return { state: 'qualified', reason: decision.reason };
  return { state: 'incomplete', reason: decision.reason };
}

export function shouldContinueLevel1(input: {
  status:
    | 'armed'
    | 'confirmed-pending-anchor'
    | 'delivered'
    | 'completed'
    | 'rejected'
    | 'incomplete'
    | 'expired';
  anchorDelivered: boolean;
  anchorOutboxExpired: boolean;
}): boolean {
  return (
    (input.status === 'armed' || input.status === 'confirmed-pending-anchor') &&
    !input.anchorDelivered &&
    !input.anchorOutboxExpired
  );
}

export function isAnchorCooldownActive(until: number | undefined, now: number): boolean {
  return until !== undefined && until > now;
}

function requiredAddress(raw: RawLevel1, field: string): string {
  return parseAddress(raw[field]);
}

function requiredDecimal(raw: RawLevel1, field: string, reasons: string[]): string | undefined {
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

function requiredDecimalOrSigned(
  raw: RawLevel1,
  field: string,
  reasons: string[],
): string | undefined {
  if (!(field in raw)) {
    reasons.push(`missing:${field}`);
    return undefined;
  }
  try {
    return parseDecimalString(raw[field]).toString();
  } catch {
    reasons.push(`invalid:${field}`);
    return undefined;
  }
}

function requiredInteger(raw: RawLevel1, field: string, reasons: string[]): number | undefined {
  if (!(field in raw)) {
    reasons.push(`missing:${field}`);
    return undefined;
  }
  try {
    return parseInteger(raw[field], { min: 0 });
  } catch {
    reasons.push(`invalid:${field}`);
    return undefined;
  }
}

function requiredTimestamp(raw: RawLevel1, field: string, reasons: string[]): number | undefined {
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

function requiredPoolStatus(value: unknown, reasons: string[]): 'stable' | 'unstable' | undefined {
  if (value === 'stable' || value === 'unstable') return value;
  reasons.push('invalid:pool_status');
  return undefined;
}
